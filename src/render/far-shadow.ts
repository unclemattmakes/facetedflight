// src/render/far-shadow.ts — terrain shadow at every distance, from one texture.
//
// DEV-116. `sim/terrain/sun-height.ts` says what the field IS and why; this
// file is the render half: upload the swept tops as one half-float texture and
// multiply the mission sun by "does this fragment see it" in every lit
// material, at every distance, on the ground, on the sea, on the props and in
// the cockpit.
//
// ── Where it goes in three's shader, and how it meets the shadow map ─────
//
// `lights_fragment_begin` multiplies `directLight.color` by `getShadow(...)`
// for the directional light, inside a block that exists only when the shadow
// map is on and the light casts. This patch rewrites that one statement to
//
//     directLight.color *= min( getShadow(...), ff2SunHeightTerm() )
//
// and adds `directLight.color *= ff2SunHeightTerm()` for the case with no map.
// MIN, not a product: both are masks of the same shadow where they overlap
// (the map at 0.68 m a texel, this at 8 m and soft), and a product of two soft
// edges of the same edge is a darker, wider edge — a min is just the darker.
// Inside the box a fragment is shadowed if EITHER says so, which is also what
// closes the map's other gap: casters are gathered only 3,500 m up-sun, and at
// 4° anything over 245 m tall casts further than that. Outside the box the
// baked term is the only one, and it is exact for terrain, so the far island
// and the near one are shadowed by the same rule. That is the whole fix.
//
// ── …and the map FADES into it, because the box's edge was a line (DEV-453) ─
//
// Exact for TERRAIN is the qualifier that mattered. What the map carries and
// the bake does not — the scatter's shadows, the landmarks', the detail
// ring's facets — stopped dead at the box's faces, and on alpine's forest
// that read as a line: *"from it to the player, shadows exist, beyond it - no
// shadows"* (Matt, 2026-09-27). Worse, DEV-304's canopy handover gave the
// forest floor's direct darkening to the map EVERYWHERE, so past the box it
// had none of either kind. So the statement is really
//
//     directLight.color *= min( mix( 1, getShadow(...), cover ), ff2SunHeightTerm() )
//
// with `cover` (`ff2ShadowCover`) 1 inside the box and falling to exactly 0
// at its faces across `render.shadows.edgeFade` metres, and the canopy
// multiply takes the direct sun back by the same `cover`. At the face both
// terms are the far rule's already, so there is nothing left to step.
//
// ── …and a NEAR map cascades into the sun's (DEV-582) ────────────────────
//
// `render/near-shadow.ts` is a second sun map over +-80 m round the eye. Inside
// its box the statement becomes
//
//     min( min( mix( 1, near, nearCover ),
//               mix( 1, getShadow( ..., bias - skip * nearCover, ... ), cover ) ),
//          ff2SunHeightTerm() )
//
// where the skip pulls the sun map's receiver toward the light by the near
// map's reach, so the two maps answer different occluders and the min is not
// a sharp shadow inside a soft copy of itself. Its GLSL and its uniforms ride
// here like the clouds' (`createFarShadow`'s third argument); the cockpit
// shell opts out by its own define, and the bias token is still in the one
// statement `cockpit-self-shadow.ts` rewrites.
//
// ── …and the CLOUDS are inside `ff2SunHeightTerm` (DEV-585) ──────────────
//
// `render/cloud-shadow.ts` owns the clouds' shadow; its GLSL rides in this
// prelude and `ff2SunHeightTerm` returns the min of the terrain's answer and
// the clouds' at every exit. So the statement above, the no-map multiply, the
// baked rung and the sea's glint all take the clouds without a second edit,
// and its uniforms are bound beside this file's (`createFarShadow`'s second
// argument). One function, so nothing can take one shadow of the sun and not
// the other.
//
// The band (`uSunTopE`) is the SUN map's, in its uv, and the loop applies it to
// every shadow-casting directional light a patched material sees. That is one
// light today: the only other directional caster is the hangar's key
// (`hangar-light.ts`, DEV-440), and nothing this file patches stands in the
// menu scene it lights. A second caster in the WORLD would want its own band.
//
// ── One texture, no per-frame work ────────────────────────────────────────
//
// RGBA16F, linearly filtered — ES 3.0 lists the 16-bit float formats as
// texture-filterable in core, so this needs no extension on a Quest. **This
// line said R16F for months and the texture was RG16F**, because a second
// channel arrived (DEV-133's signed depth) and the sentence describing the
// format did not; it is RGBA now, with DEV-295's canopy term in .b and
// DEV-296's canopy ceiling in .a — no channel is spare, and this line said .a
// was for a second time after DEV-296 filled it. The rule that would have
// caught both is to describe the format where it is CONSTRUCTED. The two `THREE.RGBAFormat` arguments below are that
// place. Half precision is ~1 m at 1,500 m and 12 cm at 200 m,
// against a 3 m soft edge. Uploaded once when a world attaches; a preset flip
// is one uniform write. Classic compiles the same program and branches on the
// uniform before the fetch, which is the pattern DEV-092 set (identity at 0).
//
// ── Coordinates ───────────────────────────────────────────────────────────
//
// The varying is the fragment's WORLD position in three space, instance-aware
// (DEV-096's lesson: at `begin_vertex` an `InstancedMesh`'s `transformed` is in
// the mesh's own frame). The field is SIM space: same x and y, z negated.
// `unity-space.ts` is the one definition; the GLSL negates z once, in one place.

import * as THREE from 'three'
import type { EditionState } from '@/game/edition'
import type { CanopyField } from '@/sim/props/canopy'
import { runSteps, type Steps } from '@/sim/steps'
import type { HeightField } from '@/sim/terrain/height-field'
import { type SunHeightField, sunHeightSteps, sunReachOf } from '@/sim/terrain/sun-height'
import {
  CLOUD_SHADOW_GLSL,
  type CloudShadowUniforms,
  createCloudShadowUniforms,
} from './cloud-shadow'
import {
  createNearCascadeUniforms,
  MAIN_BIAS_SKIPPED,
  MAIN_BIAS_TOKEN,
  NEAR_FRAGMENT_PRELUDE,
  NEAR_LOOP_LINES,
  NEAR_VERTEX_ANCHOR,
  NEAR_VERTEX_BODY,
  NEAR_VERTEX_PRELUDE,
  type NearCascadeUniforms,
  NO_NEAR_DEFINE,
} from './near-shadow'
import { chainShaderPatch, setDefineInPlace, tagProgramCacheKey } from './program-cache-key'
import { canopyDirectWeight, shadowEdgeFadeUv } from './shadows'

/** The include this patch expands. */
export const SUN_HEIGHT_INCLUDE = '#include <lights_fragment_begin>'

/** The statement inside the directional loop that the min wraps. */
const SHADOW_LINE =
  /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? (getShadow\([^;]*\)) : 1\.0;/

const DIR_BLOCK_START = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'
const DIR_BLOCK_END = '#pragma unroll_loop_end'
const RE_DIRECT_CALL = 'RE_Direct( directLight,'

/** Where the canopy term multiplies. three's own AO slot, after every light. */
export const AOMAP_INCLUDE = '#include <aomap_fragment>'

/**
 * Metres below the canopy ceiling over which a PROP's own shading fades out.
 *
 * DEV-296. Measured rather than chosen. Mean prop height foot-to-canopy-top:
 * **alpine 21.9 m, simonet 22.3, kauai 22.4, desert 6.8** — so six metres is
 * the top quarter of a tree and most of a cactus.
 *
 * **That spread was the reason to expect a fixed number to fail, and it does
 * not.** The worry was that a fade as deep as a desert prop leaves it barely
 * shaded; the arithmetic says otherwise, because the ramp is anchored at the
 * CEILING and runs DOWNWARD. A lone 6.8 m cactus is fully shaded at its foot
 * and lit at its tip — the fade covers its whole height, which is exactly
 * right for something that short — and a 2 m shrub standing under 22 m trees
 * is fully shaded everywhere, because the ceiling over it is theirs. In both
 * cases the FOOT is at full shade, and the foot is the part this is about.
 *
 * Art, not a preset number: it changes the SHAPE of the fade and not how dark
 * anything gets, which is `render.canopyShade.strength`.
 */
export const CANOPY_FADE_METRES = 6

/**
 * How much of the ground's shading a PROP takes, at its own foot.
 *
 * DEV-297. Matt, on the first build with DEV-296's prop path live: *"i wonder
 * if i'm seeing the parts of the trees that intersect the ground fade out."*
 * He was: at 1.0 a trunk standing in its own shade pool goes exactly as dark
 * as the ground it stands on, and the silhouette that tells you where the tree
 * MEETS the ground disappears into it.
 *
 * Less than one keeps that edge readable while the trunk is still plainly in
 * shade. It is the one number here whose job is a SILHOUETTE rather than a
 * brightness, which is why it is art beside `CANOPY_FADE_METRES` and not a
 * preset knob: a preset that set it to 1 would produce a picture nobody wants.
 */
export const CANOPY_PROP_FRACTION = 0.75

/**
 * The marker `SUN_HEIGHT_GLSL` leaves behind, and the canopy patch's precondition.
 *
 * PREPENDED rather than substituted, so unlike `SUN_HEIGHT_INCLUDE` it survives
 * the sun patch that emits it. See `canopyPatchFragment`.
 */
export const SUN_HEIGHT_DEFINE = '#define FF2_SUN_HEIGHT 1'

export const SUN_HEIGHT_GLSL = `
// Present in every fragment shader this patch reaches, so a material's OWN sun
// term (the water's glint, render/water.ts) can take the same shadow under
// #ifdef rather than guessing whether the function exists.
#define FF2_SUN_HEIGHT 1
uniform sampler2D uSunTopMap;
/** (originX, originZ, 1/scaleX, 1/scaleZ) — world to mesh metres, sim space. */
uniform vec4 uSunTopA;
/** (terrainSize, 1/step, 1/N, 0.5/N) — mesh metres to texel uv. */
uniform vec4 uSunTopB;
/** (sun enabled, softMetres, liftMetres, canopy enabled). */
uniform vec4 uSunTopC;
/** (canopy fade metres, prop fraction, canopy DIRECT weight, 0). */
// .x DEV-296's ramp, .y DEV-297's edge, .z DEV-304's handover to the shadow map.
uniform vec4 uSunTopD;
// DEV-497: the sun ray continued past the field's edge -- (its horizontal
// unit direction in the field's mesh metres, its fall in world metres per
// mesh metre, on). Zero .w is the old rule: off the field is lit.
uniform vec4 uSunTopF;
// WORLD -> the frame a field's origin and scale are expressed in. DEV-298.
//
// IDENTITY for every mission, and provably so rather than by convention: a
// mission's terrain group is a pure translation whose position IS the field's
// origin with z negated, so the composition cancels exactly. The TITLE valley
// is what needs it -- that group carries an 87-degree rotation, and an
// axis-aligned world->mesh mapping cannot express one, which is why the
// far-field term was never wired to the title screen at all.
//
// Two rules for prose in here, and BOTH were broken writing these lines.
// Line comments only, never the block form: the far-shadow unit test strips
// line comments before sweeping this GLSL for reserved words used as
// identifiers, so a block comment is CODE to it, and the word it tripped on
// was the most ordinary one in English. And no backticks anywhere, because
// every line of this lives inside a template literal and a pair of them ends
// the string -- which is how the second draft failed to parse.
uniform mat4 uSunTopXf;
varying vec3 vFf2SunWorld;
${CLOUD_SHADOW_GLSL}
// The fragment's position in the field's MESH metres. three space -> sim space
// is one negated z (render/unity-space.ts), and this is the one place it
// happens -- a unit test counts the occurrences, and DEV-295's canopy term was
// a second copy of this line until it did.
vec2 ff2SunMesh() {
  return ( vec2( vFf2SunWorld.x, -vFf2SunWorld.z ) - uSunTopA.xy ) * uSunTopA.zw;
}

// How much of the sun this fragment sees through the terrain: 1 lit, 0 in
// shadow. Outside the field, or with the term off, 1.
//
// Two paths, chosen per MATERIAL (DEV-133):
//  * FF2_SUN_GROUND — a terrain fragment is judged by its TEXEL's signed
//    depth (.g: positive is how far the ground there sits below its shadow
//    top, negative is how far the sun ray cleared it), never by its own
//    height. The drawn mesh carries vertex jitter and coarse LODs the field
//    does not; compared by height, a lit facet landed on either side of its
//    own top at random and lit ground came out half-lit with per-vertex
//    noise. Signed so the bilinear zero crossing — the shadow's edge on the
//    ground — falls inside a texel rather than along the 8 m grid.
//  * otherwise — the sea, a prop, a racer, the cockpit: the fragment's height
//    against the top (.r), the edge lowered by uSunTopC.z of lift so a prop's
//    foot on a jittered lit facet is still lit, one-sided below.
// Softness is max(uSunTopC.y, one pixel), so a hard preset is still an
// anti-aliased edge and never a shimmering one.
//
// DEV-585: and the CLOUDS' shadow of the same sun, folded in by a min at every
// exit, so every reader of this function (the directional loop, the no-map
// multiply, the baked rung, the sea's glint) takes both and none can take one
// without the other. Asked FIRST, so its fetch and derivatives sit above every
// branch here, and returned where this used to return 1.0: a fragment the
// terrain leaves lit is still under a cloud. DEV-238's arm below prices the
// TERRAIN fetch, which is what it was built to measure; render/cloud-shadow.ts
// has the clouds' own switch.
float ff2SunHeightTerm() {
  float ff2Cloud = ff2CloudShadowTerm();
  // ── DEV-238's arm, and it is FIRST on purpose ──────────────────────────
  //
  // Everything below is one texture fetch, one fwidth and one smoothstep, on
  // every fragment of every material this patch reaches — the sea included,
  // where the term is also called a SECOND time by water.ts's glint. Returning
  // here removes the fetch and the derivative, not just the multiply, which is
  // the difference between pricing the lookup and pricing an arithmetic op.
  //
  // fwidth in non-uniform control flow is undefined and a Quest's compiler
  // may say so — but a preprocessor conditional is not control flow. The
  // directive is resolved before the code generator sees it, so the shipped
  // program still computes the derivative unconditionally at the top of the
  // function, which is what the comment below is about.
  #ifdef FF2_NO_SUN_HEIGHT
    return ff2Cloud;
  #endif
  vec2 m = ff2SunMesh();
  // DEV-497: where the field is READ, and how far the sun ray has fallen
  // between there and this fragment. On the field that is here and nothing.
  // Off it (the object path only: land off the field does not exist), it is
  // where this fragment's ray toward the sun enters the field, and the ray's
  // fall over the distance -- nothing outside the land casts, so that top is
  // exact, and the islands' long shadows run on across the sea instead of
  // stopping at the field's edge. uSunTopF is (the ray's horizontal unit
  // direction in mesh metres, its fall per mesh metre, on). A slab test, all
  // arithmetic: the fetch below must not sit behind a branch.
  vec2 ff2At = m;
  float ff2Fall = 0.0;
  float ff2Meets = 1.0;
  #ifndef FF2_SUN_GROUND
  {
    vec2 u = uSunTopF.xy;
    vec2 su = step( vec2( 0.0 ), u ) * 2.0 - 1.0;
    vec2 iu = su / max( abs( u ), vec2( 1e-6 ) );
    vec2 ta = ( vec2( 0.0 ) - m ) * iu;
    vec2 tb = ( vec2( uSunTopB.x ) - m ) * iu;
    vec2 tn = min( ta, tb );
    vec2 tf = max( ta, tb );
    float tIn = max( max( tn.x, tn.y ), 0.0 );
    float tOut = min( tf.x, tf.y );
    ff2Meets = uSunTopF.w * step( tIn, tOut );
    ff2At = clamp( m + u * tIn * ff2Meets, vec2( 0.0 ), vec2( uSunTopB.x ) );
    ff2Fall = tIn * uSunTopF.z * ff2Meets;
  }
  #endif
  vec2 uv = ff2At * uSunTopB.y * uSunTopB.z + uSunTopB.w;
  vec2 swept = texture2D( uSunTopMap, uv ).rg;
  // The sample and its derivative BEFORE any branch: fwidth is undefined in
  // non-uniform control flow, and a Quest's compiler is entitled to say so.
  #ifdef FF2_SUN_GROUND
    float d = swept.g;
    float w = max( uSunTopC.y, fwidth( d ) );
  #else
    float d = vFf2SunWorld.y - ( swept.r - ff2Fall - uSunTopC.z );
    // fwidth of d, not of y: across a flat sea y is constant and only the
    // top moves, and a shadow line on the water would alias.
    float w = max( uSunTopC.y, fwidth( d ) );
  #endif
  w = max( w, 1e-4 );
  if ( uSunTopC.x < 0.5 ) return ff2Cloud;
  #ifdef FF2_SUN_GROUND
    if ( m.x < 0.0 || m.y < 0.0 || m.x > uSunTopB.x || m.y > uSunTopB.x ) return ff2Cloud;
  #else
    // DEV-497: off the field, lit only where the ray toward the sun misses it.
    bool ff2On = m.x >= 0.0 && m.y >= 0.0 && m.x <= uSunTopB.x && m.y <= uSunTopB.x;
    if ( !ff2On && ff2Meets < 0.5 ) return ff2Cloud;
  #endif
  #ifdef FF2_SUN_GROUND
    return min( 1.0 - smoothstep( 0.0, w, d ), ff2Cloud );
  #else
    return min( smoothstep( -w, 0.0, d ), ff2Cloud );
  #endif
}

// How much of the SKY this fragment sees past the canopy over it: 1 open field,
// 0 the darkest a preset allows. DEV-295, extended to the props by DEV-296.
//
// Two paths, and on any material that is neither this compiles to nothing at
// all -- no fetch, no branch, because the early return is a preprocessor
// conditional and not an if:
//
//   FF2_SUN_GROUND    the LAND. The texel's occlusion, flat: ground is at the
//                     bottom of whatever is over it, always.
//   FF2_CANOPY_OBJECT the PROPS. The same occlusion, ramped out over the last
//                     metres below the canopy CEILING (.a), so a fragment at
//                     the top of a tree sees the sky and one at its foot does
//                     not.
//
// The ramp is the whole of DEV-296 and not a refinement. Without it a prop is
// darkened uniformly by its own canopy -- crown included -- and a lone tree on
// an open hillside just gets darker, which reads as a bug rather than as
// shade. With it, the tallest tree in a stand lights its own crown for free,
// because the ceiling at its texel IS its own top.
//
// Deliberately NOT on the sea, the racers, the ship or the cockpit. Those go
// through the plain object path and are untouched: a canopy ceiling is a
// statement about standing under a tree, and a ship at 200 m with a palm
// somewhere below it is not doing that. DEV-296 says what it would take.
//
// The .b channel rides the same texel the sun term already fetched, at the same
// uv, on a sampler that is already bound — so the whole term is a swizzle the
// compiler is free to fold into the fetch above it. That sharing is the entire
// reason this feature is free, and it is why the field is swept onto the LAND's
// own collision grid rather than onto a grid of its own.
//
// The preset's strength is folded in by the SWEEP, so there is no second
// uniform here: a preset at zero produces a field of zeroes and this returns
// exactly 1. And no backticks in this comment, which is not a style rule --
// every line of it lives inside a template literal, and the first draft put a
// pair around one word and closed the string. The GLSL above has none for the
// same reason.
float ff2CanopyTerm() {
  #if !defined( FF2_SUN_GROUND ) && !defined( FF2_CANOPY_OBJECT )
    return 1.0;
  #endif
  if ( uSunTopC.w < 0.5 ) return 1.0;
  vec2 mc = ff2SunMesh();
  if ( mc.x < 0.0 || mc.y < 0.0 || mc.x > uSunTopB.x || mc.y > uSunTopB.x ) return 1.0;
  vec2 uvc = mc * uSunTopB.y * uSunTopB.z + uSunTopB.w;
  vec2 canopy = texture2D( uSunTopMap, uvc ).ba;
  #ifdef FF2_CANOPY_OBJECT
    // canopy.y is the ceiling's WORLD y; uSunTopD.x is the metres over which a
    // fragment climbs out of it. Zero occlusion at the ceiling and above.
    float under = 1.0 - smoothstep( canopy.y - uSunTopD.x, canopy.y, vFf2SunWorld.y );
    // uSunTopD.y holds a prop below the ground's own darkness at its foot, so
    // the line where a trunk meets its own shade pool stays readable (DEV-297).
    return 1.0 - canopy.x * under * uSunTopD.y;
  #else
    return 1.0 - canopy.x;
  #endif
}

// ── DEV-453: how much of the SHADOW MAP's verdict this fragment takes ──────
//
// Matt, on alpine: the far shadow line, where from it to the player shadows
// exist and beyond it there are none. That line is the sun map's box. Inside
// it the scatter casts and the canopy bake hands its direct half to the map
// (DEV-304); outside, the map answers lit and, before this, the bake still
// held its direct half back, so the forest floor past the box had no direct
// darkening of any kind.
//
// This is 1 deep inside the box and falls to exactly 0 at its faces, over
// uSunTopE's band: .x of the box's width across the sun, .y of its depth
// range along it. Only the FAR depth plane fades -- render/shadows.ts's
// shadowEdgeFadeUv says why the near one needs none. Two readers, both in
// this file: the directional loop mixes the map's term toward lit by it, and
// the canopy multiply hands the direct sun back to the bake by it. So where
// the map stops, both terms are already the far rule's, and there is no step.
//
// The coordinate is three's own shadow coordinate, handed in rather than read
// here, because this prelude sits above the declarations three writes for it.
// No branch and no derivative: a clamp of a min, smoothed, so a zero band is a
// hard step and never a division by zero.
uniform vec4 uSunTopE;
float ff2ShadowCover( vec4 shadowCoord ) {
  vec3 c = shadowCoord.xyz / shadowCoord.w;
  vec2 across = min( c.xy, 1.0 - c.xy );
  float lateral = min( across.x, across.y ) / max( uSunTopE.x, 1e-6 );
  float deep = ( 1.0 - c.z ) / max( uSunTopE.y, 1e-6 );
  float t = clamp( min( lateral, deep ), 0.0, 1.0 );
  return t * t * ( 3.0 - 2.0 * t );
}
// Written by the directional loop, read by the canopy multiply: the most any
// shadow-casting directional light's map covers this fragment. 0 where no map
// runs at all, which hands the direct sun to the bake -- as it always did.
float ff2MapCover = 0.0;
float ff2LightCover = 0.0;
${NEAR_FRAGMENT_PRELUDE}`

/**
 * `THREE.ShaderChunk.lights_fragment_begin` with the term spliced into the
 * DIRECTIONAL block only — the point and spot loops carry the same
 * `RE_Direct(` call and must not be touched.
 *
 * **Throws** if the anchors are gone, for the reason `illustrativeChunk` gives:
 * a build that boots and has silently lost the feature is the worst outcome.
 */
export const sunHeightChunk = (): string => {
  const chunk = THREE.ShaderChunk.lights_fragment_begin
  const start = chunk.indexOf(DIR_BLOCK_START)
  const end = start < 0 ? -1 : chunk.indexOf(DIR_BLOCK_END, start)
  if (start < 0 || end < 0) {
    throw new Error(
      "far-shadow: three's lights_fragment_begin no longer has the directional block this patch " +
        'splices into. Re-read node_modules/three/src/renderers/shaders/ShaderChunk/' +
        'lights_fragment_begin.glsl.js and update DIR_BLOCK_START / SHADOW_LINE together.',
    )
  }
  const block = chunk.slice(start, end)
  if (!SHADOW_LINE.test(block) || !block.includes(RE_DIRECT_CALL)) {
    throw new Error(
      "far-shadow: the directional block's shadow statement or RE_Direct call has changed shape; " +
        'update SHADOW_LINE / RE_DIRECT_CALL in render/far-shadow.ts.',
    )
  }
  const patched = block
    .replace(
      SHADOW_LINE,
      // DEV-453: the map's verdict fades to lit across the band inside its box
      // (`ff2ShadowCover`), so where the map ends the min is the far-field
      // term alone. Two assignments to GLOBALS before the statement, never a
      // declaration: three unrolls this loop by pasting the body once per
      // light into one scope, and a second light would redeclare a local.
      // The shadow statement stays ONE statement with the bias token inside
      // it, which is the shape `cockpit-self-shadow.ts` finds and rewrites.
      //
      // DEV-582: the near cascade's lines go first (render/near-shadow.ts),
      // and inside its box the sun map's bias carries the skip, so the sun map
      // answers only past the near map's reach. A FUNCTION replacement, because
      // the captured call is three's text and a replacement string reads $.
      (_statement: string, call: string) =>
        `ff2LightCover = receiveShadow ? ff2ShadowCover( vDirectionalShadowCoord[ i ] ) : 0.0;
		ff2MapCover = max( ff2MapCover, ff2LightCover );
		${NEAR_LOOP_LINES}
		directLight.color *= min( min( mix( 1.0, ff2NearShade, ff2NearCover ), mix( 1.0, ( directLight.visible && receiveShadow ) ? ${call.replace(MAIN_BIAS_TOKEN, MAIN_BIAS_SKIPPED)} : 1.0, ff2LightCover ) ), ff2SunHeightTerm() );`,
    )
    .replace(
      RE_DIRECT_CALL,
      `#if !( defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS ) )
		directLight.color *= ff2SunHeightTerm();
		#endif
		${RE_DIRECT_CALL}`,
    )
  return chunk.slice(0, start) + patched + chunk.slice(end)
}

/** Splice into a fragment shader; unchanged when the include is absent (see illustrative.ts). */
export const sunHeightPatchFragment = (fragmentShader: string): string =>
  fragmentShader.includes(SUN_HEIGHT_INCLUDE)
    ? `${SUN_HEIGHT_GLSL}\n${fragmentShader.replace(SUN_HEIGHT_INCLUDE, sunHeightChunk())}`
    : fragmentShader

/**
 * The canopy's multiply, spliced into three's own AO slot. DEV-295.
 *
 * `aomap_fragment` runs after `lights_fragment_end`, so `reflectedLight` is
 * fully accumulated and all four components are there to scale. Both the
 * material families this reaches — `MeshLambertMaterial` and
 * `MeshStandardMaterial` — include it, checked against three's own build in
 * `tests/unit/canopy-patch.test.ts` rather than remembered.
 *
 * ── The two `direct` lines are WEIGHTED, and that weight is the feature ──
 *
 * DEV-295 scaled all four accumulators unconditionally, and was right to, for
 * exactly one reason: `render.props.scatterShadows` was false on both presets,
 * so a tree cast nothing on the ground it stands on and there was no live
 * shadow to double. This header used to carry that as a CLAUSE — *"if it ever
 * goes true, lose the two `direct` lines"* — and DEV-304 turned it true.
 *
 * A clause is a thing somebody has to remember. `uSunTopD.z` is a thing the
 * build cannot get wrong: `render/shadows.ts`'s `canopyDirectWeight` is
 * composed from `shadowCastersFor`, which is the one expression that already
 * knows whether the scatter is really casting — preset flag, quality tier and
 * `vr.disable` folded in — and `createFarShadow`'s `apply` writes it on every
 * edition notify. Flip the flag on the Advanced page mid-flight and the weight
 * moves with it, in the same frame, with no recompile: it is a uniform and not
 * a define precisely so that a live flip costs nothing (a define would move
 * three's program cache key and rebuild every lit material — DEV-186's fifteen
 * programs, for a boolean).
 *
 * INDIRECT is never weighted. The shadow map does not touch ambient or
 * hemisphere light, so the bake is the only thing darkening it whatever the
 * caster set says, and a weight there would be a second bug in the other
 * direction.
 *
 * ── What the 0/1 handover costs, measured rather than assumed ────────────
 *
 * The map's box is `render.shadows.boxHalfSize` around the CAMERA — 700 m on
 * Anniversary — so beyond it a tree casts nothing whatever the flag says. This
 * paragraph used to go on *"and at weight 0 the far forest floor loses its
 * direct darkening entirely"*, as a cost accepted in prose, and on alpine that
 * cost was the line Matt reported (DEV-453). So the weight is now spatial: the
 * uniform says what the bake owns WHERE THE MAP IS, and `ff2MapCover` says
 * where that is, falling to 0 at the box's faces. Past the box the bake owns
 * the direct sun again, which is exactly the look a headset has everywhere.
 * And at a 4-degree sun a 20 m tree's real shadow is a ~286 m streak lying
 * DOWNSUN of it rather than a patch under it, so the two terms are not the
 * same mask: the overlap is large in a dense stand and small for the lone tree
 * DEV-297 exists for. That is a look call rather than a correctness call, and
 * the number is linear here — see `canopyDirectWeight`.
 *
 * **Throws** if the anchor is gone, for the reason `sunHeightChunk` gives: a
 * build that boots having silently lost the feature is the worst outcome.
 */
export const canopyPatchFragment = (fragmentShader: string): string => {
  // ── the precondition is the DEFINE, and the first draft used the INCLUDE ──
  //
  // This ran AFTER `sunHeightPatchFragment`, which replaces
  // `#include <lights_fragment_begin>` with the expanded chunk -- so by the
  // time this saw the shader that include was GONE, this returned it
  // untouched, and the whole feature was dead in a build whose unit tests were
  // green. The tests passed the RAW shader, which is an input the call site
  // never produces; what found it was forcing the term to 0.3 and seeing the
  // frame not move.
  //
  // `FF2_SUN_HEIGHT` is emitted by `SUN_HEIGHT_GLSL`, which is PREPENDED
  // rather than substituted, so it is still there afterwards. The precondition
  // was always "the sun patch has run", and this is that fact rather than a
  // proxy for it that the sun patch consumes.
  if (!fragmentShader.includes(SUN_HEIGHT_DEFINE)) return fragmentShader
  if (!fragmentShader.includes(AOMAP_INCLUDE)) {
    throw new Error(
      `far-shadow: the canopy term's anchor '${AOMAP_INCLUDE}' is not in this shader. ` +
        "Re-read three's meshphysical/meshlambert fragment shaders and update AOMAP_INCLUDE.",
    )
  }
  return fragmentShader.replace(
    AOMAP_INCLUDE,
    `${AOMAP_INCLUDE}
	{
		float ff2Canopy = ff2CanopyTerm();
		// uSunTopD.z is how much of the DIRECT sun this bake still owns: 1 while
		// the scatter casts nothing into the shadow map, 0 once it does and the
		// depth pass is darkening the same ground. DEV-304. And only WHERE the
		// map is: ff2MapCover is 0 past the box, so there the bake owns the
		// direct sun whatever the caster set says. DEV-453.
		float ff2CanopyDirect = mix( 1.0, ff2Canopy, mix( 1.0, uSunTopD.z, ff2MapCover ) );
		reflectedLight.directDiffuse *= ff2CanopyDirect;
		reflectedLight.indirectDiffuse *= ff2Canopy;
		reflectedLight.directSpecular *= ff2CanopyDirect;
		reflectedLight.indirectSpecular *= ff2Canopy;
	}`,
  )
}

const VERTEX_HOOK = '#include <begin_vertex>'

/**
 * Everything the vertex patch's body names and three does not already declare.
 *
 * It is its own exported constant because the FRAGMENT half declares the same
 * uniforms inside `SUN_HEIGHT_GLSL`, and the two halves are separate shaders:
 * `uSunTopXf` was added to the body and to the fragment prelude only, which
 * compiles a vertex shader referencing an undeclared name — `VALIDATE_STATUS
 * false` and `1282` on the title screen, and NOTHING in the unit tests, which
 * asserted the body's text and never asked what it could resolve.
 * `far-shadow.test.ts` now sweeps the emitted vertex shader for undeclared
 * `uSunTop*` names, so the next one fails in node rather than in a headset.
 */
export const VERTEX_PRELUDE = 'uniform mat4 uSunTopXf;\nvarying vec3 vFf2SunWorld;'

/** The vertex side: the instance-aware world position, one varying. */
export const sunHeightPatchVertex = (vertexShader: string): string =>
  `${VERTEX_PRELUDE}\n${NEAR_VERTEX_PRELUDE}\n${vertexShader}`
    // DEV-582: the near map's coordinate, where three makes its own. Kept
    // after the include, which `cockpit-self-shadow.ts` anchors on as well.
    .replace(NEAR_VERTEX_ANCHOR, () => `${NEAR_VERTEX_ANCHOR}\n${NEAR_VERTEX_BODY}`)
    .replace(
      VERTEX_HOOK,
      `${VERTEX_HOOK}
	{
		vec4 ff2SunLocal = vec4( transformed, 1.0 );
		#ifdef USE_INSTANCING
			ff2SunLocal = instanceMatrix * ff2SunLocal;
		#endif
		vFf2SunWorld = ( uSunTopXf * modelMatrix * ff2SunLocal ).xyz;
	}`,
    )

/**
 * The sweep's input, from the level: `lighting.sun.direction` is where light
 * TRAVELS, three space. Toward the sun is its negation; sim space negates z.
 */
export const towardSunSim = (
  travelThree: readonly [number, number, number] | readonly number[],
): [number, number, number] => [
  -(travelThree[0] as number),
  -(travelThree[1] as number),
  travelThree[2] as number,
]

/**
 * Half-float encode the field as interleaved (top, depth) pairs — one RG16F
 * texel each. Exported for the round-trip test.
 *
 * Depth rides in its own channel rather than being recovered as `top − ground`
 * in the shader because its SIGN must be right on lit ground: a half-float top
 * at 1,500 m carries a 1 m quantum, and a difference of two such numbers is
 * noise of that size exactly where the ground path needs to know which side of
 * zero it is on. Stored directly, a small signed depth keeps its full half-float
 * precision — 1 mm at a metre.
 */
export const encodeSunField = (
  tops: Float32Array,
  depths: Float32Array,
  canopy?: Float32Array | null,
  ceiling?: Float32Array | null,
): Uint16Array => {
  const out = new Uint16Array(tops.length * 4)
  for (let i = 0; i < tops.length; i++) {
    out[4 * i] = THREE.DataUtils.toHalfFloat(tops[i] as number)
    out[4 * i + 1] = THREE.DataUtils.toHalfFloat(depths[i] as number)
    out[4 * i + 2] = THREE.DataUtils.toHalfFloat(canopy ? ((canopy[i] as number) ?? 0) : 0)
    out[4 * i + 3] = THREE.DataUtils.toHalfFloat(ceiling ? ((ceiling[i] as number) ?? 0) : 0)
  }
  return out
}

/**
 * WORLD -> the frame a field's origin and scale are expressed in. DEV-298.
 *
 * `translate(originX, originY, -originZ) * inverse(groupMatrixWorld)`, and the
 * shape of that is the argument for it: the field's origin is the terrain's
 * transform in SIM space, a terrain group's matrix places that same terrain in
 * the world, so the composition undoes the placement and puts the origin back.
 *
 * **For a mission it is EXACTLY the identity**, and that is measured rather
 * than assumed: `rookie_01`'s group sits at (-2157.92, 15.88, 1867.14) and its
 * field origin is (-2157.92, 15.88, -1867.14) — the same translation with z
 * negated, which is the sim/three flip. The two cancel. So this needs no
 * special case for the shipped path and no flag: hand it the group and a
 * mission gets identity by arithmetic.
 *
 * The TITLE valley is the one that needs it. Its group carries a quaternion of
 * (0.0246, 0.686, -0.0527, 0.7253) — about 87 degrees of yaw with a tilt — and
 * an axis-aligned `(world - origin) / scale` cannot express a rotation. That
 * is why the far-field term was never wired to the title screen: not an
 * oversight, a mapping that could not reach it.
 */
export const worldToFieldMatrix = (
  field: Pick<SunHeightField, 'originX' | 'originY' | 'originZ'>,
  groupMatrixWorld: THREE.Matrix4 | null | undefined,
): THREE.Matrix4 => {
  const out = new THREE.Matrix4()
  if (!groupMatrixWorld) return out
  return out
    .makeTranslation(field.originX, field.originY, -field.originZ)
    .multiply(new THREE.Matrix4().copy(groupMatrixWorld).invert())
}

/**
 * The sun's travel direction in the frame the FIELD is marched in. DEV-359.
 *
 * DEV-298 gave the SHADER a matrix, `worldToFieldMatrix`, so a title-valley
 * fragment is looked up where it sits on the rotated map. The MARCH was not
 * given one: it was handed `TITLE_SUN.direction` in WORLD space and walked it
 * across a height field that lives in the valley's own mesh frame. The valley
 * carries 2016's 87-degree yaw and 6.7-degree tilt, so the rays it swept came
 * from a sun **59.8 degrees** away from the one in the sky — 40.9 degrees up at
 * an azimuth of -79.4 in the field frame, against 39.3 at 1.9 in the world.
 * Every texel's verdict was answered for the wrong sun, and the sky-visibility
 * bounce reads the same field's `towardSun`.
 *
 * A ray is a point plus a displacement, and a displacement goes through the
 * LINEAR part of the world-to-field map; the translation `worldToFieldMatrix`
 * adds cancels out of a direction. That linear part is the inverse of the
 * group's, so this is `transformDirection` by the inverted group matrix, which
 * also renormalises.
 *
 * **Null or omitted returns the input untouched** — not normalised, not
 * copied through a `Vector3` — so a mission, which passes no matrix, marches
 * the level's own vector to the bit. That is a property of this line rather
 * than a claim about a run, and `far-shadow.test.ts` holds it.
 */
export const sunTravelInFieldFrame = (
  sunTravelThree: readonly number[],
  groupMatrixWorld: THREE.Matrix4 | null | undefined,
): readonly number[] => {
  if (!groupMatrixWorld) return sunTravelThree
  return new THREE.Vector3(
    sunTravelThree[0] as number,
    sunTravelThree[1] as number,
    sunTravelThree[2] as number,
  )
    .transformDirection(new THREE.Matrix4().copy(groupMatrixWorld).invert())
    .toArray()
}

/**
 * The canopy channel, or nothing, checked against the grid it has to ride.
 *
 * A canopy field swept on a different grid to the sun's would sample at the
 * wrong texel everywhere — a silent, plausible, completely wrong picture — so
 * the sizes are compared rather than assumed. They agree by construction today
 * (both come from the LAND's `HeightField`), and this is what makes that a
 * checked fact instead of a convention two files apart.
 */
export const canopyOcclusionFor = (
  vertPerSide: number,
  canopy: CanopyField | null | undefined,
): Float32Array | null => {
  if (!canopy) return null
  if (canopy.vertPerSide !== vertPerSide) {
    throw new Error(
      `far-shadow: the canopy field is ${canopy.vertPerSide}² and the sun field is ` +
        `${vertPerSide}². They share one texture and must share one grid.`,
    )
  }
  return canopy.occlusion
}

/**
 * The spacing of half-float values around `v`: `2^(floor(log2 |v|) − 10)`.
 * 0.5 m at 512–1,024, 1 m at 1,024–2,048. What a stored top can be wrong by.
 */
export const halfFloatStep = (v: number): number => {
  const a = Math.max(Math.abs(v), 2 ** -14)
  return 2 ** (Math.floor(Math.log2(a)) - 10)
}

/**
 * How far below a swept top the OBJECT path lowers its edge, metres (DEV-133).
 *
 * `jitterMetres` is the land's `randomOffset`: the drawn ground a prop stands
 * on sits up to that far under the field's own surface, so a palm's foot on a
 * lit texel — where top IS the ground — would otherwise be judged under the
 * top and shaded. Plus one half-float quantum at the field's highest top,
 * which is the most a stored top can round upward. Derived, not typed: the
 * sheet owns the jitter and the format owns the quantum.
 */
export const sunLiftMetres = (jitterMetres: number, maxTop: number): number =>
  Math.max(jitterMetres, 0) + halfFloatStep(maxTop)

/**
 * Which path a material takes through `ff2SunHeightTerm` (DEV-133).
 *
 *  * `ground` — the LAND's chunk material: judged by its texel's depth, never
 *    by the fragment's height. Only the land; the sea has a height of its own
 *    to compare and is not the ground the field describes.
 *  * `object` — everything else: the sea, racers, the ship, clouds.
 *  * `prop` — an `object` for the SUN term, plus DEV-296's canopy ramp: a
 *    scattered prop is shaded by the forest it stands in, fading out as its
 *    own fragments rise past the canopy ceiling over them.
 */
export type SunHeightRole = 'ground' | 'object' | 'prop'

export interface FarShadow {
  /**
   * Chain onto a material. Idempotent per material. No-op for unlit materials.
   * A `ground` call on a material already patched as an object still sets the
   * define — the role is read at compile, and the land is seen exactly once.
   */
  applyTo(material: THREE.Material, role?: SunHeightRole): void
  /**
   * Hand over the LAND field and the mission sun's travel direction (three
   * space) when a world attaches; `null` when it goes. Sweeps and uploads.
   * `jitterMetres` is the land's vertex jitter (`randomOffset`, mesh metres ×
   * the terrain's y scale), from which the object path's lift is derived.
   */
  setWorld(
    field: HeightField | null,
    sunTravelThree: readonly number[] | null,
    jitterMetres?: number,
    canopy?: CanopyField | null,
    /**
     * The terrain GROUP's world matrix, for DEV-298's world -> field mapping.
     * Null or omitted is the identity, which is what a mission resolves to
     * anyway — see `worldToFieldMatrix`.
     */
    groupMatrixWorld?: THREE.Matrix4 | null,
  ): SunHeightField | null
  /**
   * `setWorld`, as a bake that can stop after every row of the march
   * (DEV-355). `setWorld` IS this, drained in one go; `boot/slice.ts` drains it
   * a frame's budget at a time so a world build does not stop the frames.
   */
  setWorldSteps(
    field: HeightField | null,
    sunTravelThree: readonly number[] | null,
    jitterMetres?: number,
    canopy?: CanopyField | null,
    groupMatrixWorld?: THREE.Matrix4 | null,
    /**
     * DEV-955: the march, already done (baked at content-build time or kept
     * from an earlier load) for exactly these inputs; the texture is built from
     * it in place of running `sunHeightSteps`. Null or omitted marches.
     */
    baked?: SunHeightField | null,
  ): Steps<SunHeightField | null>
  /** The live field, for tests, the console and the cockpit's own readout. */
  readonly field: SunHeightField | null
  /** The object path's live lift, metres. `sunLiftMetres` of the attached world. */
  readonly liftMetres: number
  /** Whether the term is multiplying anything right now. */
  readonly on: boolean
  /** Whether the CANOPY term is. Independent of `on` — they share a fetch, not a switch. */
  readonly canopyOn: boolean
  /**
   * How much of the DIRECT sun the canopy bake owns right now, 0..1. DEV-304.
   *
   * Exposed because it is the half of the double-count fix a test can READ:
   * the shader text says the weight is applied, and this says what it resolves
   * to for a given preset and quality tier. `tests/unit/canopy-direct.test.ts`
   * walks the matrix of both against `shadowCastersFor`.
   */
  readonly canopyDirect: number
  dispose(): void
}

/**
 * The live term: one uniform block shared by every material it patches.
 *
 * `editionState` decides `on`: `render.sunHeight.enabled` on the live preset.
 * Unlike the map (`shadowsEnabled`) it does NOT consult the quality setting —
 * one texture fetch per lit fragment is cheaper than the map's five taps, and
 * a Quest at quality `low` is exactly where a free far-field term earns its
 * place.
 */
export const createFarShadow = (
  editionState: EditionState,
  /**
   * DEV-585: the clouds' block (`render/cloud-shadow.ts`'s `CloudShadow.uniforms`),
   * bound beside this file's own in every program it patches, because
   * `ff2SunHeightTerm` calls the clouds' term. Omitted is a block built OFF,
   * which is what a caller with no clouds (a unit test, the title) wants.
   */
  cloudUniforms?: CloudShadowUniforms,
  /**
   * DEV-582: the near cascade's block (`render/near-shadow.ts`'s
   * `NearShadow.uniforms`), bound the same way. Omitted is a block built OFF.
   */
  nearUniforms?: NearCascadeUniforms,
): FarShadow => {
  const near = nearUniforms ?? createNearCascadeUniforms()
  const ownCloudUniforms = cloudUniforms ? null : createCloudShadowUniforms()
  const clouds = cloudUniforms ?? (ownCloudUniforms as CloudShadowUniforms)
  // One texel, (top far below anything, depth 0): lit everywhere.
  const placeholder = new THREE.DataTexture(
    encodeSunField(new Float32Array([-1e4]), new Float32Array([0])),
    1,
    1,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  )
  placeholder.needsUpdate = true
  let texture: THREE.DataTexture | null = null
  let field: SunHeightField | null = null
  let lift = 0
  let hasCanopy = false

  const uniforms = {
    uSunTopMap: { value: placeholder as THREE.Texture },
    uSunTopA: { value: new THREE.Vector4(0, 0, 1, 1) },
    uSunTopB: { value: new THREE.Vector4(0, 1, 1, 0.5) },
    /** (sun enabled, softMetres, liftMetres, CANOPY enabled). */
    uSunTopC: { value: new THREE.Vector4(0, 3, 0, 0) },
    /** (canopy fade metres, prop fraction, canopy DIRECT weight, 0). DEV-296, DEV-304. */
    uSunTopD: { value: new THREE.Vector4(CANOPY_FADE_METRES, CANOPY_PROP_FRACTION, 1, 0) },
    /** World -> field frame. Identity for a mission; the title valley's inverse. DEV-298. */
    uSunTopXf: { value: new THREE.Matrix4() },
    /**
     * (edge band across the sun, edge band along it, 0, 0), in the sun map's
     * own uv — `shadowEdgeFadeUv` of the live preset. DEV-453.
     */
    uSunTopE: { value: new THREE.Vector4(0, 0, 0, 0) },
    /**
     * (toward-sun x, z in the field's mesh metres, fall per mesh metre, on):
     * the ray continued past the field's edge. `sunReachOf` of the live field;
     * .w 0 for none, which lights everything off the field. DEV-497.
     */
    uSunTopF: { value: new THREE.Vector4(1, 0, 0, 0) },
  }
  const patched = new WeakSet<THREE.Material>()

  const apply = (): void => {
    const s = editionState.current.render.sunHeight
    const c = editionState.current.render.canopyShade
    // The two terms share one texture and one fetch and are otherwise
    // INDEPENDENT: `render.sunHeight.enabled` gates x, `render.canopyShade`
    // gates w, and a preset or an Advanced-page row may move either without
    // the other noticing. Sharing a fetch is a performance decision and must
    // not become a semantic one — a switch that turns off a feature it does
    // not name is exactly DEV-269's "a control that appears to work and does
    // not", one level up.
    uniforms.uSunTopC.value.set(
      s.enabled && field ? 1 : 0,
      s.softMetres,
      lift,
      c.enabled && c.strength > 0 && hasCanopy ? 1 : 0,
    )
    // DEV-304. The bake's DIRECT half hands over to the shadow map the moment
    // the scatter is really in the caster set, or the ground under a tree is
    // darkened once by each. Composed from `shadowCastersFor` rather than read
    // off `props.scatterShadows.enabled`, which is wrong at quality `low` (no
    // map, so nothing to hand to) and wrong while presenting (`vr.disable` has
    // already turned the flag off). See `canopyPatchFragment`.
    uniforms.uSunTopD.value.z = canopyDirectWeight(editionState.current, editionState.settings)
    // DEV-453. The band the map's verdict fades out over, in its own uv. Written
    // whether or not the map is on: with no map the loop that reads it is not
    // compiled, and a preset that turns the map on finds it already right.
    const band = shadowEdgeFadeUv(editionState.current.render.shadows)
    uniforms.uSunTopE.value.set(band.lateral, band.depth, 0, 0)
  }

  const unsubscribe = editionState.subscribe(apply)
  apply()

  const self: FarShadow = {
    applyTo(material, role = 'object') {
      if (role === 'prop') {
        // DEV-296. A separate define from the ground's, because the two paths
        // are different code and three folds `defines` into the program cache
        // key — so the props compile their own program and the sea, the ship
        // and the racers keep theirs untouched.
        setDefineInPlace(material, 'FF2_CANOPY_OBJECT', true)
        tagProgramCacheKey(material, 'canopy-object')
      }
      if (role === 'ground') {
        // A define, not a uniform: the two paths are different code, and the
        // uniform block is shared by every material this reaches. three folds
        // `material.defines` into the program cache key, so the land compiles
        // its own program and nothing else moves.
        setDefineInPlace(material, 'FF2_SUN_GROUND', true)
        tagProgramCacheKey(material, 'sun-ground')
      }
      // The whole body is `after`: it returns before touching anything when the
      // include is absent, so no step of the helper may run ahead of that check.
      chainShaderPatch(
        material,
        {
          tag: 'sun-height',
          after: (shader) => {
            if (!shader.fragmentShader.includes(SUN_HEIGHT_INCLUDE)) return
            Object.assign(shader.uniforms, uniforms, clouds, near)
            // DEV-582: a vertex half with no shadow coordinate of its own leaves the
            // near varying unwritten, so its fragment half is told to read none.
            const nearAnchored = shader.vertexShader.includes(NEAR_VERTEX_ANCHOR)
            shader.vertexShader = sunHeightPatchVertex(shader.vertexShader)
            shader.fragmentShader = sunHeightPatchFragment(shader.fragmentShader)
            if (!nearAnchored) shader.fragmentShader = `${NO_NEAR_DEFINE}\n${shader.fragmentShader}`
            // DEV-295, and the decision is read from the DEFINE rather than from a
            // role captured in this closure, because a material patched as an
            // object can be given the ground role afterwards -- which this file
            // already says, three lines up, about the define itself. On anything
            // else the canopy term compiles to `return 1.0` and splicing its
            // multiply in would be waste; worse, `canopyPatchFragment` throws on a
            // shader with no AO slot, and a custom one that carries
            // `lights_fragment_begin` without `aomap_fragment` is legal.
            if (
              material.defines?.FF2_SUN_GROUND !== undefined ||
              material.defines?.FF2_CANOPY_OBJECT !== undefined
            ) {
              shader.fragmentShader = canopyPatchFragment(shader.fragmentShader)
            }
          },
        },
        patched,
      )
    },
    setWorld(land, sunTravelThree, jitterMetres = 0, canopy = null, groupMatrixWorld = null) {
      return runSteps(
        self.setWorldSteps(land, sunTravelThree, jitterMetres, canopy, groupMatrixWorld),
      )
    },
    // DEV-355: the march first, yielding, and the swap after it in one go — so
    // a frame drawn while the march is suspended sees the old field whole, never
    // a disposed texture or a null one.
    *setWorldSteps(
      land,
      sunTravelThree,
      jitterMetres = 0,
      canopy = null,
      groupMatrixWorld = null,
      baked = null,
    ) {
      // DEV-359: the march runs in the FIELD's frame, so the sun goes into it
      // first. A mission passes no matrix and marches the level's own vector.
      const sunInField = sunTravelThree
        ? sunTravelInFieldFrame(sunTravelThree, groupMatrixWorld)
        : null
      const marched =
        land && sunInField
          ? (baked ?? (yield* sunHeightSteps(land, towardSunSim(sunInField))))
          : null
      texture?.dispose()
      texture = null
      field = null
      lift = 0
      hasCanopy = (canopy?.meanOcclusion ?? 0) > 0
      if (land && sunTravelThree && marched) {
        field = marched
        lift = sunLiftMetres(jitterMetres, field.maxTop)
        const n = field.vertPerSide
        texture = new THREE.DataTexture(
          encodeSunField(
            field.tops,
            field.depths,
            canopyOcclusionFor(field.vertPerSide, canopy),
            canopy?.ceiling ?? null,
          ),
          n,
          n,
          THREE.RGBAFormat,
          THREE.HalfFloatType,
        )
        texture.magFilter = THREE.LinearFilter
        texture.minFilter = THREE.LinearFilter
        texture.wrapS = THREE.ClampToEdgeWrapping
        texture.wrapT = THREE.ClampToEdgeWrapping
        texture.generateMipmaps = false
        texture.needsUpdate = true
        uniforms.uSunTopMap.value = texture
        uniforms.uSunTopA.value.set(
          field.originX,
          field.originZ,
          1 / (field.scaleX || 1),
          1 / (field.scaleZ || 1),
        )
        uniforms.uSunTopB.value.set(field.terrainSize, 1 / field.step, 1 / n, 0.5 / n)
        uniforms.uSunTopXf.value.copy(worldToFieldMatrix(field, groupMatrixWorld))
        // DEV-497. The same ray the march took, for fragments off the field.
        const reach = sunReachOf(field)
        if (reach) uniforms.uSunTopF.value.set(reach.ux, reach.uz, reach.dropPerMetre, 1)
        else uniforms.uSunTopF.value.set(1, 0, 0, 0)
      } else {
        uniforms.uSunTopMap.value = placeholder
        uniforms.uSunTopXf.value.identity()
        uniforms.uSunTopF.value.set(1, 0, 0, 0)
      }
      apply()
      return field
    },
    get field() {
      return field
    },
    get liftMetres() {
      return lift
    },
    get on() {
      return uniforms.uSunTopC.value.x > 0.5
    },
    get canopyOn() {
      return uniforms.uSunTopC.value.w > 0.5
    },
    get canopyDirect() {
      return uniforms.uSunTopD.value.z
    },
    dispose() {
      unsubscribe()
      texture?.dispose()
      placeholder.dispose()
      ownCloudUniforms?.uFf2CloudMap.value.dispose()
    },
  }
  return self
}
