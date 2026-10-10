// src/render/fragment-gates.ts — three named cuts in the terrain's fragment
// stack, each behind a `#define`, each flippable ON A LIVE MATERIAL.
//
// ── Why this exists, and why the word RUNTIME is the whole point ──────────
//
// `docs/plan/VR-PERF-WAVE-2-WORK.md` §8 puts the terrain chunks' FILL at
// ~4.3 ms of a worn 11.7 — the single largest item in the frame, ahead of
// everything else by a factor of two. DEV-182 built the ladder that would price
// it (`?terrainLit=standard|noibl|lambert|basic`) and could not take the
// reading, and the reason is not the ladder:
//
// **`?terrainLit=` is decided when the mesh is built, so an A/B is two LOADS.**
// `docs/testing/perf-protocol.md` §3a-ter says this laptop cannot do a
// cross-run comparison of anything fill-dominated — a bracketed A-B-A of one
// such pair came back 4.82 / 4.27 / 7.05 ms for two arms that are the same
// build, because at 2516 px with 4x samples the GPU throttles INSIDE the three
// seconds the ring is filling. Every number that instrument produced about a
// load-time pin is void, and no amount of care with the pin fixes it.
//
// What does work, and has an R2 of 0.999 to show for it, is the WITHIN-run
// protocol: hide a group, read, put it back, read again, and let the drift
// column say whether the machine moved underneath you. That protocol needs a
// switch that can be thrown between two readings of one page. A material class
// cannot be (a mesh is built with one), and a context attribute cannot be
// (`?aa=`, DEV-165) — but a `#define` can: three hashes `material.defines` into
// `getProgramCacheKey`, so flipping one and setting `needsUpdate` fetches a
// DIFFERENT program, and flipping it back fetches the first one out of the
// cache. One compile per arm per session, then free.
//
// So these are DEV-182's rungs rebuilt as gates. Not a replacement for it —
// `lambert` and `basic` really are different material classes and really do
// have to be two loads — but the two questions that can be answered without
// changing the class are the two that matter, and they are now answerable on
// the instrument that works.
//
// ── The three gates ──────────────────────────────────────────────────────
//
//   FF2_NO_IBL             the two PMREM fetches — `getIBLIrradiance` and
//                          `getIBLRadiance`. DEV-182 photographed this cut at
//                          **0.9-2.2 levels of 255 on Simonet's land** and
//                          4.3-5.1 on the desert, so it is a candidate and not
//                          a curiosity; what it has never had is a price.
//
//   FF2_NO_POINT_LIGHTS    the whole `NUM_POINT_LIGHTS` loop. See below: on a
//                          mission frame this is arithmetic whose result is
//                          EXACTLY zero, on 51 % of the screen, every frame.
//
//   FF2_UNLIT              the floor — write the diffuse colour and let the
//                          driver dead-code the lighting behind it. Not a
//                          candidate (it is `?terrainLit=basic`'s picture, the
//                          "mobile-toy ditch" of DEV-182 §3a) but the number
//                          that says whether the remaining fill is SHADING or
//                          RASTERISATION, which is the difference between
//                          attacking the shader and attacking the geometry.
//
// **The default sets none of them, and the compiled program does not move.**
// The guards are `#ifndef`/`#endif` around statements the preprocessor keeps,
// which is DEV-184's mechanism exactly — the GLSL preprocessor removes a gated
// statement before the driver's code generator sees it, and leaves a gate whose
// define is absent alone. The GLSL *string* is eight lines longer; the *program*
// is the same one.
//
// ── The point-light gate is not a trade, and that is worth stating twice ──
//
// `render/cockpit-interior.ts` puts two `THREE.PointLight`s in the mission
// scene to light a dashboard, and three has no per-object light scoping:
// `NUM_POINT_LIGHTS` is a define on EVERY lit material in the frame, so the
// island, the sea, the props and the ship each run two `RE_Direct_Physical`
// evaluations — GGX, Smith, Fresnel, a Lambert — per fragment, for a lamp in
// the cabin.
//
// Since DEV-186 they are in the count *unconditionally*. That row is right
// about why — hiding the cabin took `numPointLights` 2 -> 0, which bumps
// `WebGLLights.state.version`, which recompiles every lit material in the
// scene, measured at **15 programs on one press of V** — so the lamps now stay
// in the scene at zero intensity instead of leaving it. What that trade bought
// is a compile storm removed; what it costs is those two evaluations on every
// frame of every mission, in THIRD person as well as first.
//
// The file records the cost as *"measured at 0.15 ms against a 0.19 ms drift,
// i.e. inside the noise"*. **That reading is from the discredited rig** —
// `render-census.spec.ts`, 1280 x 720, vsync on — which is one seventh of one
// worn eye and is the exact instrument §10(1) of the working notes retracted
// three rankings from. A per-fragment cost measured at a seventh of its pixels
// is not small, it is measured small.
//
// And the cut is not an art call, because the contribution is not small — it is
// zero, by construction. Both lamps carry a `distance` (3 m and 1.8 m) and
// three's `getDistanceAttenuation` multiplies by
//
//     pow2( saturate( 1.0 - pow4( lightDistance / cutoffDistance ) ) )
//
// whenever `cutoffDistance > 0`. Past the cutoff `saturate` returns 0 and the
// whole term is 0 — not a small number, the number zero. Everything in a
// mission scene except the cabin itself is further from the pilot's seat than
// 3 m. So a chunk of island 400 m away spends two BRDF evaluations to multiply
// them by nothing.
//
// This module does not TAKE that cut anywhere. It makes it measurable, on the
// instrument that works, so the decision is made against a number.

import * as THREE from 'three'
import { LOD_FADE_DEFINE } from './lod-fade-define'
import { chainShaderPatch } from './program-cache-key'

/** The gates, by the define each one sets. */
export const GATE_NO_IBL = 'FF2_NO_IBL'
export const GATE_NO_POINT_LIGHTS = 'FF2_NO_POINT_LIGHTS'
export const GATE_UNLIT = 'FF2_UNLIT'

// ── DEV-238's seven, and why they are splices in OTHER files ─────────────
//
// The three above are cuts THIS file makes into three of three's own chunks.
// The seven below are cuts into GLSL this repo wrote, and each one lives in the
// file that owns the text it guards:
//
//   FF2_NO_FOG / FF2_NO_HAZE          `render/unity-fog.ts`
//   FF2_NO_SUN_HEIGHT                 `render/far-shadow.ts`
//   FF2_NO_CLOUD_SHADOW               `render/cloud-shadow.ts` (DEV-585, the eighth)
//   FF2_WATER_NO_COAST                `render/water.ts`, the COAST_HOOK splice
//   FF2_WATER_NO_NORMAL               `render/water.ts`, the dFdx/dFdy facet
//   FF2_WATER_NO_SPECULAR             `render/water.ts`, the Blinn glint
//   FF2_WATER_NO_REFLECT              `render/water.ts`, the SH sky + Fresnel
//
// The registry is HERE so that one door — `parseFragmentGates`,
// `setFragmentGates`, `__ff2.fragmentGates` — sets every one of them, and so
// that a gate cannot be added without landing in `FRAGMENT_GATES` and therefore
// in the sweep that CLEARS an arm. A gate an arm cannot put back is a
// contaminated page for the rest of the session.
//
// **The `FF2_WATER_*` four are inert on the LAND and that is not a bug** — it
// is the reason `__ff2.fragmentGates` takes a `which`. Setting one on the
// island defines a name no statement in its shader reads: a recompile, bought
// nothing. So an ocean arm is thrown with `which: 'ocean'`, and the mechanism
// check is *the define on a live WATER material*, never a count of materials
// moved.
export const GATE_NO_FOG = 'FF2_NO_FOG'
export const GATE_NO_HAZE = 'FF2_NO_HAZE'
export const GATE_NO_SUN_HEIGHT = 'FF2_NO_SUN_HEIGHT'
export const GATE_WATER_NO_COAST = 'FF2_WATER_NO_COAST'
export const GATE_WATER_NO_NORMAL = 'FF2_WATER_NO_NORMAL'
export const GATE_WATER_NO_SPECULAR = 'FF2_WATER_NO_SPECULAR'
export const GATE_WATER_NO_REFLECT = 'FF2_WATER_NO_REFLECT'
/**
 * DEV-585's arm: `render/cloud-shadow.ts`'s term returns before its fetch.
 * The same define the clouds' own material carries to opt out, so the arm and
 * the opt-out cannot drift apart. The term's uniform switch is AFTER the fetch
 * (derivatives first), so `?feature=render.cloudShadow:off` cannot price the
 * lookup; this can.
 */
export const GATE_NO_CLOUD_SHADOW = 'FF2_NO_CLOUD_SHADOW'

export type FragmentGate =
  | 'noIbl'
  | 'noPointLights'
  | 'unlit'
  | 'lodFade'
  | 'noFog'
  | 'noHaze'
  | 'noSunHeight'
  | 'waterNoCoast'
  | 'waterNoNormal'
  | 'waterNoSpecular'
  | 'waterNoReflect'
  | 'noCloudShadow'

/**
 * Every gate, in a FIXED order — and the order is load-bearing rather than
 * tidiness.
 *
 * `setFragmentGates` rebuilds the defines it owns in THIS order whenever the
 * set changes, so two arms wanting the same gates produce the same
 * `material.defines` insertion order and therefore the same program cache key.
 * three walks `for ( const name in parameters.defines )`, which is insertion
 * order, so `{A,B}` and `{B,A}` are two keys for one piece of GLSL — DEV-194,
 * which cost a 318 ms compile in the air. Appending to this list is free;
 * REORDERING it changes every multi-gate arm's key and is not.
 */
export const FRAGMENT_GATES: readonly FragmentGate[] = [
  'noIbl',
  'noPointLights',
  'unlit',
  'lodFade',
  'noFog',
  'noHaze',
  'noSunHeight',
  'waterNoCoast',
  'waterNoNormal',
  'waterNoSpecular',
  'waterNoReflect',
  'noCloudShadow',
]

/**
 * `lodFade` is the ODD ONE, and it is the reason this list is not just the
 * three defines above.
 *
 * The other gates are cuts this file splices in. `FF2_LOD_FADE` is
 * `render/lod-fade.ts`'s own, already in the base terrain material's shader
 * text and already switched off — DEV-184 moved the screen-door `discard`
 * behind it, so the base compiles without it and only a live cross-fade's
 * clones set it.
 *
 * That row shipped **gated and unmeasured**: *"on this GPU early depth test
 * survives a `discard` and only the write is lost, so the win is uncertain"*,
 * and the milliseconds were left as TO BE TAKEN ON A QUIET MACHINE because six
 * agents were sharing the box. Setting the define here puts the `discard` back
 * into the base material's program — which is precisely DEV-184's own **Arm A**,
 * the one its §3 asks a reader to reconstruct by hand-editing a line — so the
 * arm that needed two builds becomes one sweep of one page, bracketed, on the
 * protocol that works.
 *
 * `uLodFade.y` is 0 on a settled chunk, so the branch is present and never
 * taken. That is the whole point: what a `discard` costs is decided by the
 * shader TEXT, not by whether the branch is entered.
 */
export const GATE_DEFINES: Readonly<Record<FragmentGate, string>> = {
  noIbl: GATE_NO_IBL,
  noPointLights: GATE_NO_POINT_LIGHTS,
  unlit: GATE_UNLIT,
  lodFade: LOD_FADE_DEFINE,
  noFog: GATE_NO_FOG,
  noHaze: GATE_NO_HAZE,
  noSunHeight: GATE_NO_SUN_HEIGHT,
  waterNoCoast: GATE_WATER_NO_COAST,
  waterNoNormal: GATE_WATER_NO_NORMAL,
  waterNoSpecular: GATE_WATER_NO_SPECULAR,
  waterNoReflect: GATE_WATER_NO_REFLECT,
  noCloudShadow: GATE_NO_CLOUD_SHADOW,
}

/**
 * `noIbl,unlit` -> the gates. Unknown names warn and are dropped, which is
 * `parseTerrainLit`'s rule for its reason: a bad query string must never be a
 * black page.
 */
export const parseFragmentGates = (
  raw: string | null,
  warn: (message: string) => void = () => {},
): FragmentGate[] => {
  if (raw === null) return []
  const out: FragmentGate[] = []
  for (const token of raw.split(',').map((t) => t.trim())) {
    if (token.length === 0) continue
    if ((FRAGMENT_GATES as readonly string[]).includes(token)) {
      if (!out.includes(token as FragmentGate)) out.push(token as FragmentGate)
      continue
    }
    warn(`fragment gate "${token}" is not one of ${FRAGMENT_GATES.join(', ')}; ignored`)
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────
// The anchors, and why each is TWO anchors
// ─────────────────────────────────────────────────────────────────────────
//
// `onBeforeCompile` receives the shader with its `#include` directives still
// in it, and the patches in this repo take two different shapes against that:
// `unity-fog.ts` injects BESIDE an include and leaves it, while
// `far-shadow.ts` REPLACES `#include <lights_fragment_begin>` with an expanded,
// rewritten copy of the chunk. Both are on the terrain's material.
//
// So whether a given statement is in the text when this patch runs depends on
// which other patches ran first — and that is decided by install order, which
// is decided by `boot/app.ts`. Anchoring on the include alone silently does
// nothing once somebody else has expanded it; anchoring on the statement alone
// silently does nothing when nobody has.
//
// Hence: patch the STATEMENT where it is already there, expand the include
// where it is not, and then **assert the gate is in the output**. A patch that
// is a no-op wearing a feature's clothes is the failure this whole family of
// files keeps paying for (DEV-069, and `noIblChunk`'s own throw).

/**
 * The two IBL fetches, exactly as three 0.185.1's `lights_fragment_maps` has
 * them — and the SAME LIST `?terrainLit=noibl` cuts.
 *
 * Exported and imported back by `terrain-mesh.ts` rather than written twice.
 * The load-time rung and this gate are the same cut, and DEV-182's photographs
 * are the pictures of BOTH: five stands, five loads, a same-build control, and
 * a land mask derived from a render. If the two lists were allowed to drift,
 * the millisecond this gate returns would be priced against a picture nobody
 * has taken.
 */
export const IBL_CALLS = [
  'iblIrradiance += getIBLIrradiance( geometryNormal );',
  'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );',
] as const

/**
 * The one line that opens the point-light loop in `lights_fragment_begin`.
 *
 * Exported and imported back by `point-light-scope.ts` — DEV-192 takes this
 * cut PERMANENTLY on every material outside the cabin, and it has to be the
 * same statement this gate prices or the shipped cut and the measured cut are
 * two different things. Same argument as `IBL_CALLS` two doors up.
 */
export const POINT_LIGHT_IF = '#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )'

/** The one statement `opaque_fragment` exists to perform. */
const OPAQUE_WRITE = 'gl_FragColor = vec4( outgoingLight, diffuseColor.a );'

interface Anchor {
  /** The chunk the statement lives in, for the expand-the-include fallback. */
  readonly include: string
  readonly chunk: keyof typeof THREE.ShaderChunk
  readonly needles: readonly string[]
  readonly rewrite: (source: string) => string
}

const gateIbl = (source: string): string =>
  IBL_CALLS.reduce(
    (text, call) => text.replace(call, `#ifndef ${GATE_NO_IBL}\n\t\t\t${call}\n#endif`),
    source,
  )

const gatePointLights = (source: string): string =>
  source.replace(POINT_LIGHT_IF, `${POINT_LIGHT_IF} && ! defined( ${GATE_NO_POINT_LIGHTS} )`)

const gateUnlit = (source: string): string =>
  source.replace(
    OPAQUE_WRITE,
    `#ifdef ${GATE_UNLIT}\n\tgl_FragColor = vec4( diffuseColor.rgb, 1.0 );\n#else\n\t${OPAQUE_WRITE}\n#endif`,
  )

const ANCHORS: readonly Anchor[] = [
  {
    include: '#include <lights_fragment_maps>',
    chunk: 'lights_fragment_maps',
    needles: IBL_CALLS,
    rewrite: gateIbl,
  },
  {
    include: '#include <lights_fragment_begin>',
    chunk: 'lights_fragment_begin',
    needles: [POINT_LIGHT_IF],
    rewrite: gatePointLights,
  },
  {
    include: '#include <opaque_fragment>',
    chunk: 'opaque_fragment',
    needles: [OPAQUE_WRITE],
    rewrite: gateUnlit,
  },
]

/** How many times `needle` occurs in `text`. */
const count = (text: string, needle: string): number => text.split(needle).length - 1

/**
 * Put all three gates into one fragment shader.
 *
 * **Throws** rather than returning something plausible. Every failure here is
 * silent by nature — the shader still compiles, the frame still renders, and
 * the gate simply never fires — which is the shape of DEV-069's four sessions
 * of a control scheme that described itself correctly in prose and was not the
 * one the game shipped.
 */
export const gateFragmentShader = (source: string): string => {
  let text = source
  for (const anchor of ANCHORS) {
    const present = anchor.needles.every((n) => count(text, n) === 1)
    if (!present) {
      // Nobody has expanded this include yet, so the statements are not in the
      // text: expand it here, gated, and let whoever comes after us see the
      // chunk rather than the directive.
      const chunk = THREE.ShaderChunk[anchor.chunk]
      for (const needle of anchor.needles) {
        if (count(chunk, needle) !== 1) {
          throw new Error(
            `fragment-gates: three's ${String(anchor.chunk)} no longer contains exactly one ` +
              `"${needle}". Re-read node_modules/three/src/renderers/shaders/ShaderChunk/ and ` +
              'update this file.',
          )
        }
      }
      if (count(text, anchor.include) !== 1) {
        throw new Error(
          `fragment-gates: the shader has neither "${anchor.include}" nor the statements it ` +
            'expands to. Another patch has rewritten it into a shape this file does not know.',
        )
      }
      text = text.replace(anchor.include, anchor.rewrite(chunk))
      continue
    }
    text = anchor.rewrite(text)
  }
  // The assertion the throws above cannot make: the gates are in the OUTPUT.
  for (const define of [GATE_NO_IBL, GATE_NO_POINT_LIGHTS, GATE_UNLIT]) {
    if (!text.includes(define)) {
      throw new Error(`fragment-gates: ${define} did not land in the patched shader.`)
    }
  }
  return text
}

/** Materials that already carry the patch, so installing twice is a no-op. */
const installed = new WeakSet<THREE.Material>()

/**
 * The gate defines a material CARRIED BEFORE this module first touched it, and
 * which `setFragmentGates` may therefore never take away.
 *
 * `FF2_LOD_FADE` is not ours. `render/lod-fade.ts` sets it on the pooled clones
 * of a live cross-fade, and those clones hang off chunk meshes — so a sweep
 * that walks a terrain group to find everything it draws finds them too, and
 * `setFragmentGates(m, [])` at the end of an arm would strip the define the
 * fade needs. The clone would then draw solid, both LODs would draw on top of
 * each other, and **the cross-fade would silently stop working for the rest of
 * the session** — which is DEV-184's own inverted test arriving from the other
 * side: same key plus different shader means the fade does nothing.
 *
 * So a gate this module did not set is a gate it does not clear.
 */
const floor = new WeakMap<THREE.Material, Set<string>>()

/**
 * Gate defines this module has written into a given `defines` OBJECT. DEV-238.
 *
 * The floor is computed lazily, the first time a material is handed to
 * `setFragmentGates` — and the ocean's bands share ONE defines object with
 * their base, so a band cut while an arm is live would read that arm's own
 * defines as though they were `lod-fade`'s: a floor the sweep could never
 * clear, and a page contaminated for the rest of the session by an arm that
 * looked like it went back.
 *
 * A name this module put there is never somebody else's, whichever material
 * asks. That is the whole rule, and it is a property of the object rather than
 * of the material because the object is the thing that is shared.
 */
const managed = new WeakMap<object, Set<string>>()

const floorOf = (material: THREE.Material): Set<string> => {
  const known = floor.get(material)
  if (known) return known
  const defines = (material.defines ?? {}) as Record<string, unknown>
  const mine = managed.get(defines)
  const had = new Set(
    FRAGMENT_GATES.map((g) => GATE_DEFINES[g]).filter(
      (d) => Object.hasOwn(defines, d) && !mine?.has(d),
    ),
  )
  floor.set(material, had)
  return had
}

/**
 * Install the gates on one material. Idempotent.
 *
 * **Install this LAST**, after every other `onBeforeCompile` on the material.
 * A chain calls its predecessor first, so the last one installed is the last to
 * run, and this is the one that has to see `far-shadow.ts`'s expansion of
 * `lights_fragment_begin` rather than the include it replaced. (`gateFragment
 * Shader` copes with either, but only one order leaves far-shadow its anchor.)
 */
export const installFragmentGates = (material: THREE.Material): void => {
  if (installed.has(material)) return
  // Pin the floor NOW, while nothing has been thrown — the earliest moment at
  // which "what this material carried before we touched it" is knowable
  // without having to subtract our own work back out of it. DEV-238.
  floorOf(material)
  chainShaderPatch(material, { tag: 'fragment-gates', fragment: gateFragmentShader }, installed)
}

/** Whether `material` carries the gates. */
export const hasFragmentGates = (material: THREE.Material): boolean => installed.has(material)

/**
 * How many times each `defines` OBJECT has been changed, and which of those
 * changes each MATERIAL has been told about. DEV-238.
 *
 * ── Why the object and not the material ──────────────────────────────────
 *
 * Because a `defines` object in this renderer is not private to one material.
 * `water.ts`'s `materialFor` cuts a per-LOD band with `clone.defines = defines`
 * — the base's object, BY REFERENCE, deliberately, so `applyVariant` moves
 * every band with two property writes. Every ocean material therefore shares
 * one object, and the version this function used to read off that object could
 * not tell "this material is already in the wanted state" from "somebody else
 * put it there and this material has not been recompiled since".
 *
 * The consequence was a silent half-arm, and it is exactly the failure this
 * whole family of files is built against. `__ff2.fragmentGates([...],
 * 'ocean')` calls this once per water material. The FIRST call (the base)
 * mutated the shared object and set `needsUpdate`; every call after it saw
 * `want === has` on the same object, returned `false`, and **never set
 * `needsUpdate` on the band**. three keeps a material's compiled program until
 * its `version` moves, so the sea drew ONE band through the gated program and
 * every other band through the ungated one — and the arm reported
 * `moved: 1`, which reads like a mechanism check passing.
 *
 * A version on the OBJECT plus a watermark per MATERIAL says the true thing:
 * *this material's program is stale with respect to the defines it is going to
 * be compiled from.* It costs two WeakMap reads and it is right for a shared
 * object, a private one, and a clone cut after the fact alike.
 *
 * `needsUpdate` is still only paid on a real change, which is the property the
 * original comment defends and which a sweep depends on: setting the same arm
 * twice must not put a compile inside the second reading.
 */
const definesVersion = new WeakMap<object, number>()
const materialSeen = new WeakMap<THREE.Material, number>()

export const setFragmentGates = (
  material: THREE.Material,
  gates: readonly FragmentGate[],
): boolean => {
  const keep = floorOf(material)
  const defines = (material.defines ?? {}) as Record<string, unknown>
  // The gates this module may manage HERE. A define the material carried
  // before we first touched it is not ours to move — and not ours to reorder
  // either, which is why the rebuild below skips it rather than deleting and
  // re-adding it at the end.
  const ours = FRAGMENT_GATES.filter((g) => !keep.has(GATE_DEFINES[g]))
  const wanted = ours.filter((g) => gates.includes(g))
  const present = ours.filter((g) => Object.hasOwn(defines, GATE_DEFINES[g]))
  const changed = wanted.length !== present.length || wanted.some((g, i) => present[i] !== g)
  if (changed) {
    // ── REBUILT in FRAGMENT_GATES order, never patched in place (DEV-194) ──
    //
    // `getProgramCacheKey` walks `for ( const name in parameters.defines )`,
    // which is JavaScript insertion order, so a set of defines reached by
    // adding `unlit` to `{noIbl}` and the same set reached by adding `noIbl`
    // to `{unlit}` are TWO keys for one shader. The in-place version of this
    // loop produced both — it appended whatever was missing and left whatever
    // was there — which made an arm's key a function of the order the sweep
    // happened to visit its arms in rather than of the arm.
    //
    // Deleting our own and re-adding them in one fixed order costs a handful
    // of property writes on a path that already dirties the material, and buys
    // a key that is a pure function of the arm. Foreign defines — three's
    // `STANDARD`, and anything in `keep` — are never touched, so their slots
    // do not move either.
    const mine = managed.get(defines) ?? new Set<string>()
    for (const gate of ours) {
      delete defines[GATE_DEFINES[gate]]
      mine.add(GATE_DEFINES[gate])
    }
    for (const gate of wanted) defines[GATE_DEFINES[gate]] = ''
    managed.set(defines, mine)
    definesVersion.set(defines, (definesVersion.get(defines) ?? 0) + 1)
  }
  const version = definesVersion.get(defines) ?? 0
  if ((materialSeen.get(material) ?? 0) === version) return false
  materialSeen.set(material, version)
  material.defines = defines
  material.needsUpdate = true
  return true
}
