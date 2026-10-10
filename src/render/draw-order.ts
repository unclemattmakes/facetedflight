// src/render/draw-order.ts — what the GPU is actually handed, in order, and
// two switches that change it. DEV-238, made the DEFAULT by DEV-241.
//
// ── What DEV-241 changed, and what it did not ────────────────────────────
//
// DEV-238 built the two switches as instruments and left them off; wave 4 then
// measured them, and both are now the shipped order. The numbers, from
// `docs/plan/VR-PERF-WAVE-4.md` §3.5 (queues D and E, GPU ms p50 at 2016
// px/eye, every bracket 0.01–0.04):
//
//     sky last     -0.20 adv_02_jumpSeat · -0.25 int_01_hoverJet
//                  -0.18 int_02_hoverJet · ~-0.18 hoverJet_kauai_beg
//     ocean late   -0.46 adv_02_jumpSeat · -0.19 kauai · 0 int_01_hoverJet
//     both         -0.74 / -0.79 on adv_02_jumpSeat, the first mission under
//                  the 7.78 ms p95 rule — and not a pixel moved
//
// The sky is worth the same everywhere and needs no ocean to pay: alpine and
// desert have no water terrain at all (`load-terrain.ts:406`) and `int_02`
// still reads -0.18. The ocean's is mission-shaped, because what it buys is
// the sea the LAND covers — a wash on the release mission, where the HoverJet's
// line over Simonet covers less of it — and **never negative on any mission
// measured.**
//
// ── The default is the switch THROWN AT CONSTRUCTION ─────────────────────
//
// `render/sky.ts` builds the dome in the pre-DEV-241 state and then calls
// `setSkyLast(dome, true)`; `game/terrain/load-terrain.ts` calls
// `setOceanLate(group, true)` once a WATER terrain's chunks exist. There is no
// second opinion about what "off" means anywhere in the tree: `priorSky` and
// `priorOrder` record the constructed state, so `drawOrderSwitch(which, false)`
// restores the build wave 4 measured against, exactly, and the A/B arm is a
// subtraction from the shipped frame rather than a reconstruction of an old
// one. That inversion is the whole of what DEV-241 does to this file.
//
// ── Why order is a lever that deletion is not ────────────────────────────
//
// `docs/plan/VR-PERF-WAVE-3.md` §10.3 bracketed four groups from both
// directions on `adv_02_jumpSeat`, the cheapest mission in the game, and EVERY
// one of them diverges:
//
//     world-terrain   subtractive 1.67   additive 2.72
//     world-ocean     subtractive 1.16   additive 1.89
//     sky-dome        subtractive 0.25   additive 0.38
//
// A group whose two readings agree is genuinely that expensive. One where they
// diverge has a cost that is mostly **occlusion relationship** — and you cannot
// delete a relationship, you can only change which side of it a thing is on.
// `PERF-JOURNEY.md` §3 is the same fact from the other end and is the most
// counter-intuitive number in the programme: hiding the terrain made the frame
// **0.52 ms SLOWER**, because the island was occluding the sea and the water
// shader outweighs the entire cost of drawing the island.
//
// ── The thing that decides the order today, and it is not depth ──────────
//
// three sorts the opaque list with `painterSortStable`, and read out of the
// pinned build (`node_modules/three/build/three.module.js`, r0.185.1, and
// `tests/unit/draw-order.test.ts` reads it there rather than trusting this
// comment) the comparison is:
//
//     groupOrder -> renderOrder -> material.id -> materialVariant -> z
//
// **`material.id` comes BEFORE `z`.** So "opaques are drawn front to back" is
// true only WITHIN one material. Across two materials — the island's chunk
// material and the sea's band clones — the order is decided by which was
// CONSTRUCTED first, which is an accident of `game/terrain/load-terrain.ts`.
// Nothing in this renderer has ever chosen it, and a 262 km plate whose sort
// key would be the depth of its own origin could not have chosen it well
// either: the plate's nearest pixel is under the ship and its position is
// kilometres away.
//
// That is what makes a `renderOrder` switch a real instrument rather than a
// re-shuffle of something already tuned.
//
// ── The three switches ───────────────────────────────────────────────────
//
//   OCEAN LATE   every ocean mesh to `renderOrder` 1, which puts the whole sea
//                after every opaque terrain band whatever the material ids
//                say. `depthWrite` and `depthTest` are untouched and stay on,
//                so the island's depth is already in the buffer when the sea
//                arrives and early-Z can reject a sea fragment behind it
//                before the water's stack runs. That stack is three lights of
//                GGX, an SH sky radiance, a Blinn lobe and two screen-space
//                derivatives — see `render/water.ts`.
//
//   SKY LAST     the dome from `renderOrder` -1000 to after everything, with
//                `depthTest` back ON and its clip-space z pinned to the far
//                plane. See `setSkyLast` for why `sky.ts`'s own reasoning for
//                drawing it FIRST survives the change rather than being
//                overturned by it.
//
//   COCKPIT      the player's vehicle to `renderOrder` -1 — ahead of the
//   FIRST        terrain, the props, the clouds and the racers, so the near
//                field is in the depth buffer before anything the world
//                shades. DEV-246, and Matt's question. It was ALREADY mostly
//                true by accident, which is the reason it is now a switch:
//                `material.id` put the hull early and the cockpit INTERIOR
//                late, and an accident can drift. Only opaque, depth-writing,
//                depth-testing meshes at three's default order are eligible;
//                `setCockpitFirst` says why each of those four is a condition
//                and not a filter.
//
// **All three are ON by default since DEV-241 / DEV-246, and all restore
// exactly.** Passing `false` is the A/B arm now — it subtracts the default and
// hands back the state `sky.ts`, `load-terrain.ts` and the two flight loaders
// constructed. A switch that could not be
// put back would contaminate the page for the rest of the session, which is the
// same failure an un-clearable fragment gate would be
// (`render/fragment-gates.ts`), and it is now the SHIPPED order it would fail
// to restore rather than an experiment's.
//
// ── What has to be true of everything ELSE in the frame ──────────────────
//
// Moving the dome from -1000 to 2 changes one thing that can be reasoned about
// in general: an object submitted BEFORE the dome is now at risk of being
// painted over by it, where before it was painted over the dome and kept.
// The dome at `z = w` with `LEQUAL` passes only where the depth buffer is still
// at its cleared 1.0, so the condition is exact:
//
//   **an OPAQUE object submitted before the dome must write depth.**
//
// Three facts close it, and each is a property rather than a list. (1) three
// keeps two render lists and draws every opaque before every transparent, so a
// transparent object is after the dome whatever its `renderOrder` — which is
// the whole of the comfort horizon (5), the motes (9), the gate spray (10), the
// HUD (10), the results plate (11), the pause plate (12) and the vignette
// (10,000). (2) Every opaque group in the world — the chunks, the props, the
// dressing, the clouds, `horizon-geo`, the pads, the start grid, the racers,
// the ring STUDS — is left at `renderOrder` 0 with `depthWrite` on, so the
// dome is rejected wherever any of them drew. (3) The ring FRAMES, the finish
// gate's frame and the turn-indicator arrows do carry `depthWrite: false`, and
// they are `transparent: PROPS.checkpointRing.frameBlends`, which the generated
// sheet gives as **true** — so they are in the transparent list and (1) covers
// them. That is read off the sheet rather than off the alpha, because
// `frameBlends` is the material's own `m_ShaderKeywords` and an extraction that
// ever flipped it would move those three meshes into the opaque list where
// their missing depth write WOULD matter. `tests/unit/draw-order.test.ts` §4
// asserts the condition over the constant, so that flip lands red here.
//
// `render/coast.ts` has no drawable of its own — the shore is a term inside the
// water's fragment shader — so it moves with the sea by construction and there
// is nothing to order.
//
// **DEV-246's condition is the same sentence read from the other end**, and it
// is why `setCockpitFirst` is a filter with four clauses rather than a
// traverse. Moving an object from 0 to -1 puts it before the whole world, so:
//
//   **an OPAQUE object submitted before the TERRAIN must write depth and must
//   depth-test**, or the world paints over it instead of being rejected by it.
//
// Late and depth-testing, a non-depth-writing opaque mesh still wins where it
// is nearer; early, it is simply overwritten. That is exactly the shape of
// DEV-241 §5b's medal shell (opaque, `depthWrite: false`), which is why the
// eligibility test reads the MATERIAL rather than a list of names — the next
// such object is found by the property, not by having been remembered.

import type * as THREE from 'three'
import { chainShaderPatch, setDefineInPlace } from './program-cache-key'

/** One draw, as it was submitted. */
export interface DrawRow {
  /** Position in this frame's submission sequence, from 0. */
  readonly seq: number
  /** `boot/render-census.ts`'s `rowKey()`, so it reads against the census. */
  readonly group: string
  /** The object's own name, or its type when it has none. */
  readonly name: string
  /** `material.name`, which is how a water BAND is told from the base. */
  readonly material: string
  /** three's `material.id` — the tiebreak that decides order today. */
  readonly materialId: number
  readonly renderOrder: number
  readonly transparent: boolean
  readonly depthWrite: boolean
  readonly depthTest: boolean
  /** Triangles in the submitted range, or in the whole geometry when ungrouped. */
  readonly triangles: number
  /** `shadow` when three substituted a depth material, otherwise `color`. */
  readonly pass: 'shadow' | 'color'
}

/** One `renderer.render()` call's worth of submissions. */
export interface DrawFrame {
  readonly rows: readonly DrawRow[]
}

/** Consecutive rows of one group, folded. The shape a ledger table wants. */
export interface DrawRun {
  readonly group: string
  readonly pass: 'shadow' | 'color'
  readonly calls: number
  readonly triangles: number
  /** Where the run starts in the frame's sequence. */
  readonly from: number
  /** The renderOrder every call in the run carried, or null if they differed. */
  readonly renderOrder: number | null
}

/**
 * Fold a frame's rows into runs — *sky, then 175 terrain chunks, then 8 ocean* —
 * which is the answer the question was asked for.
 *
 * Consecutive only. A group that appears twice with something else between it
 * comes back as two runs, and that interleaving is the whole point: a table
 * that grouped by name would hide exactly the fact it was built to show.
 */
export const drawRuns = (rows: readonly DrawRow[]): DrawRun[] => {
  const runs: DrawRun[] = []
  let open: {
    group: string
    pass: 'shadow' | 'color'
    calls: number
    triangles: number
    from: number
    renderOrder: number | null
  } | null = null
  for (const row of rows) {
    if (open !== null && open.group === row.group && open.pass === row.pass) {
      open.calls++
      open.triangles += row.triangles
      if (open.renderOrder !== row.renderOrder) open.renderOrder = null
      continue
    }
    if (open !== null) runs.push({ ...open })
    open = {
      group: row.group,
      pass: row.pass,
      calls: 1,
      triangles: row.triangles,
      from: row.seq,
      renderOrder: row.renderOrder,
    }
  }
  if (open !== null) runs.push({ ...open })
  return runs
}

/** Triangles a draw of this geometry submits, counting the group's range. */
const trianglesOf = (
  geometry: THREE.BufferGeometry,
  group: { start: number; count: number } | null,
): number => {
  const index = geometry.index
  const total = index ? index.count : (geometry.getAttribute('position')?.count ?? 0)
  const count = group ? Math.min(group.count, total - group.start) : total
  return Math.max(0, Math.floor(count / 3))
}

interface RendererLike {
  render: (scene: THREE.Object3D, camera: THREE.Camera) => void
  renderBufferDirect: (
    camera: THREE.Camera,
    scene: THREE.Scene | null,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    object: THREE.Object3D,
    group: { start: number; count: number } | null,
  ) => void
}

/**
 * Record the real per-frame submission sequence for `frames` frames.
 *
 * ── Why `renderBufferDirect` and not `onBeforeRender` ────────────────────
 *
 * Because the question is what reaches the GPU, and only one of the two is
 * that. `onBeforeRender` would have to be installed on every drawable object,
 * which means finding them — and a group that streams in mid-flight, a pooled
 * LOD-fade clone or a `BatchedMesh`'s members would each be a way to miss one
 * and never know. `renderBufferDirect` is ONE assignment on the renderer and
 * every draw in the frame goes through it, the shadow pass included.
 *
 * ── The frame boundary ───────────────────────────────────────────────────
 *
 * `renderer.render` is wrapped as well, and only the OUTERMOST call opens a
 * frame: `PMREMGenerator` and any cube camera call `render` re-entrantly, and a
 * sequence that treated those as frames would report the sky's own prefilter as
 * the game's draw order. In an XR frame three calls `render` once with an
 * `ArrayCamera`, so both eyes land in one sequence — which is honest, and is
 * why the flat page with `?view=cam` is enough to answer the ordering question.
 *
 * ── And OUTERMOST is not enough, which cost a run ────────────────────────
 *
 * The first version counted every outermost `render` as a frame, and the first
 * headed run came back with *"1 submissions this frame"* and a single row
 * reading `Mesh / 1 triangle`. That is `FullScreenQuad`: every post pass calls
 * `renderer.render( _mesh, _camera )` on a scene of its own, AFTER the world's
 * render has returned — so it is not nested and a depth counter cannot see it.
 * Two of three captured "frames" were the bloom composer's fullscreen triangle.
 *
 * So a frame is a render OF THE WORLD'S SCENE, by identity. `isWorldFrame` is
 * supplied by the caller because this module has no business knowing which
 * scene that is, and identity is the only test that cannot be fooled by a pass
 * that renders something scene-shaped.
 *
 * ── And the scene is not enough either, which cost the SECOND run ────────
 *
 * `render/bloom.ts` renders the stage TWICE per frame with one camera: the
 * world with `UI_LAYER` disabled, then — after `clearDepth()` — the UI with
 * `camera.layers.set(UI_LAYER)`. Same scene object, same camera object, two
 * passes. The second run's three "frames" came back as world, then `jumpseat`
 * alone, then world: the middle one was the HUD.
 *
 * Hence the CAMERA is passed as well. The caller's test in `boot/app.ts` is
 * *can this camera see layer 0*, which is the default layer everything in the
 * world is on and the one thing a UI-only pass has masked off. That it is a
 * question about the camera rather than about a count is the point: a rule
 * like "take the biggest frame" would be right most of the time and would
 * quietly pick the HUD on a frame where the world was culled.
 *
 * Restores both functions before it resolves, whatever happened.
 */
export const captureDrawOrder = (
  renderer: unknown,
  keyOf: (object: THREE.Object3D) => string,
  frames = 1,
  /**
   * Which `render()` calls are FRAMES. Defaults to all of them, which is right
   * only for a renderer with no post-processing and no second pass on it.
   */
  isWorldFrame: (scene: THREE.Object3D, camera: THREE.Camera) => boolean = () => true,
  /** Give up rather than hang if the loop is not running. */
  timeoutMs = 5000,
): Promise<DrawFrame[]> => {
  const r = renderer as RendererLike
  const priorRender = r.render
  const priorBuffer = r.renderBufferDirect
  const captured: { rows: DrawRow[] }[] = []
  let depth = 0
  let current: { rows: DrawRow[] } | null = null
  let done = false

  const restore = (): void => {
    if (done) return
    done = true
    r.render = priorRender
    r.renderBufferDirect = priorBuffer
  }

  return new Promise<DrawFrame[]>((resolve) => {
    const finish = (): void => {
      restore()
      resolve(captured.map((f) => ({ rows: f.rows })))
    }
    const timer = setTimeout(finish, timeoutMs)

    r.renderBufferDirect = function patched(camera, scene, geometry, material, object, group) {
      if (current !== null) {
        // `Material.id` is the tiebreak three's opaque sort uses BEFORE `z`,
        // and it is not in the published typings — read off the object, which
        // is where three sets it.
        const m = material as unknown as {
          id?: number
          isMeshDepthMaterial?: boolean
          isMeshDistanceMaterial?: boolean
        }
        current.rows.push({
          seq: current.rows.length,
          group: keyOf(object),
          name: object.name || object.type,
          material: material.name || material.type,
          materialId: m.id ?? -1,
          renderOrder: object.renderOrder,
          transparent: material.transparent,
          depthWrite: material.depthWrite,
          depthTest: material.depthTest,
          triangles: trianglesOf(geometry, group),
          pass:
            m.isMeshDepthMaterial === true || m.isMeshDistanceMaterial === true
              ? 'shadow'
              : 'color',
        })
      }
      priorBuffer.call(this, camera, scene, geometry, material, object, group)
    }

    r.render = function patched(scene, camera) {
      // Outermost AND the world's own scene AND a camera that can see it.
      // Each of the three lets something through on its own: a post pass is
      // outermost and not nested, `FullScreenQuad`'s scene is `Scene`-shaped,
      // and the UI pass is the SAME scene and the SAME camera with a different
      // layer mask.
      const opens = depth === 0 && isWorldFrame(scene, camera)
      if (opens) {
        current = { rows: [] }
        captured.push(current)
      }
      depth++
      try {
        priorRender.call(this, scene, camera)
      } finally {
        depth--
        if (opens) {
          current = null
          if (captured.length >= frames) {
            clearTimeout(timer)
            finish()
          }
        }
      }
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Switch 1 — the ocean after every opaque terrain band (DEFAULT since DEV-241)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The `renderOrder` the OCEAN LATE default puts on the sea.
 *
 * 1, not 100: the only thing it has to beat is the terrain's 0, and three
 * compares `renderOrder` before `material.id`, so any positive number is the
 * whole of the change. Staying next to 0 leaves room for `render/motes.ts` (9),
 * the gate spray (10) and everything above them to keep meaning what they mean.
 */
export const OCEAN_LATE_ORDER = 1

// There is deliberately NO `OCEAN_EARLY_ORDER` beside it. The sea's chunks are
// built at three's own default and `setOceanLate(group, true)` records that in
// `priorOrder` before it moves them, so the OFF arm restores what the
// constructor made rather than a number written down twice — and the test that
// says so asserts *the sea is back level with the land*, which is true whatever
// either of them is set to (trap 24).

/** What an object's order was before a switch touched it. */
const priorOrder = new WeakMap<THREE.Object3D, number>()

export interface DrawOrderReport {
  /** Objects whose state this call actually changed. */
  readonly moved: number
  /** Objects the switch looked at. */
  readonly seen: number
  /** True when the switch is now on. */
  readonly on: boolean
}

/**
 * Put every mesh under `group` after (or back level with) the opaque terrain.
 *
 * **`on` is the DEFAULT since DEV-241** and `false` is the A/B arm.
 * `load-terrain.ts` calls this with `true` once a water terrain's chunks are
 * built, which seeds `priorOrder` from the constructed `OCEAN_EARLY_ORDER` — so
 * `false` restores exactly the order wave 4's baselines were taken at.
 *
 * `depthWrite` and `depthTest` are deliberately NOT touched. They are already
 * both on — the sea is an opaque `MeshStandardMaterial` — and that is exactly
 * the condition early-Z needs: the island writes its depth first, the sea
 * arrives second, and a sea fragment behind the island is rejected before the
 * water's fragment stack runs. Turning either off would be a different
 * experiment wearing this one's name.
 *
 * **Above water the sea has no `discard` in its shader text** (DEV-167's
 * variant), which is the other half of the condition: a fragment shader that
 * can discard cannot be depth-tested early on most drivers, and that is why
 * this made no difference at all during the launch ride and -0.46 ms on
 * `adv_02_jumpSeat`'s flight (queue D, d-02).
 *
 * ── Re-asserting is free, and the streamer needs it to be ────────────────
 *
 * Every mesh, every call, idempotent: `moved` counts what THIS call changed and
 * `seen` what is there. A chunk born after the call — the fade's transient
 * `incoming` mesh is the only one on this path — takes its order from the slot
 * mesh it is fading with, so a cross-fade pair can never straddle two orders.
 */
export const setOceanLate = (group: THREE.Object3D | null, on: boolean): DrawOrderReport => {
  if (group === null) return { moved: 0, seen: 0, on: false }
  let moved = 0
  let seen = 0
  group.traverse((object) => {
    if (
      !(object as THREE.Mesh).isMesh &&
      !(object as THREE.Object3D & { isBatchedMesh?: boolean }).isBatchedMesh
    ) {
      return
    }
    seen++
    if (!priorOrder.has(object)) priorOrder.set(object, object.renderOrder)
    const want = on ? OCEAN_LATE_ORDER : (priorOrder.get(object) as number)
    if (object.renderOrder === want) return
    object.renderOrder = want
    moved++
  })
  return { moved, seen, on }
}

// ─────────────────────────────────────────────────────────────────────────
// Switch 2 — the sky last, at the far plane (DEFAULT since DEV-241)
// ─────────────────────────────────────────────────────────────────────────

/**
 * `renderOrder` for the dome under SKY LAST.
 *
 * After the ocean's 1 and after every terrain band, and BELOW `render/horizon
 * .ts`'s 5 — the horizon band is drawn over the sky on purpose and has to stay
 * there. 2 is the only free slot between them, and that it is tight is the
 * point: the claim is that the sky goes last among the *world's* opaques, not
 * that it goes last in the frame. (Everything at 5 and above is transparent, so
 * three draws it after every opaque whatever the number says — the ordering
 * against those is belt and braces, not the mechanism.)
 */
export const SKY_LAST_ORDER = 2

/**
 * The order the dome was submitted at before DEV-241, paired with
 * `depthTest: false`: a true background, drawn first and overwritten by
 * everything.
 *
 * `render/sky.ts` builds the dome at this and then throws the default, so the
 * OFF arm is the constructed state rather than a second copy of it. Same
 * reasoning as `OCEAN_EARLY_ORDER`.
 */
export const SKY_FIRST_ORDER = -1000

/** Set while the dome's clip-space z is pinned to the far plane. */
export const SKY_FAR_PIN_DEFINE = 'FF2_SKY_FAR_PIN'

const SKY_VERTEX_TAIL = '#include <fog_vertex>'

/**
 * Pin `gl_Position.z` to `gl_Position.w`, i.e. to the far plane, when the
 * define is set.
 *
 * `z = w` is a PLANE in clip space, so the near-plane clipper interpolates it
 * exactly and a dome triangle that straddles the eye still comes out on the far
 * plane. That is the standard trick and it is why the dome's radius stays
 * arbitrary under this switch as much as it is under the shipped one.
 */
const skyFarPinPatch = (source: string): string => {
  const pin = `
#ifdef ${SKY_FAR_PIN_DEFINE}
  // The far plane exactly. Paired with depthTest ON and depthWrite OFF, so the
  // dome fills only the pixels nothing else has written and never occludes.
  gl_Position.z = gl_Position.w;
#endif
`
  if (source.includes(SKY_VERTEX_TAIL))
    return source.replace(SKY_VERTEX_TAIL, `${SKY_VERTEX_TAIL}${pin}`)
  // No fog on the sky dome, so three may not have emitted that include at all.
  // Append inside `main` instead, at the last closing brace.
  const end = source.lastIndexOf('}')
  if (end < 0) throw new Error('draw-order: the sky vertex shader has no main() to append to.')
  return `${source.slice(0, end)}${pin}${source.slice(end)}`
}

interface SkyPriorState {
  readonly renderOrder: number
  readonly depthTest: boolean
  readonly depthWrite: boolean
}

const priorSky = new WeakMap<THREE.Object3D, SkyPriorState>()
const pinned = new WeakSet<THREE.Material>()

export interface SkyLastReport extends DrawOrderReport {
  readonly renderOrder: number
  readonly depthTest: boolean
  readonly depthWrite: boolean
  /** True once the far-plane pin is in the dome's compiled shader text. */
  readonly pinned: boolean
}

/**
 * Draw the sky dome LAST among the world's opaques, at the far plane.
 *
 * **`on` is the DEFAULT since DEV-241** and `false` is the A/B arm.
 * `render/sky.ts` calls this with `true` on the dome it has just built, so
 * `priorSky` holds the pre-DEV-241 state and `false` hands it back.
 *
 * ── Does `sky.ts`'s own reasoning still hold? Yes, in a different form ────
 *
 * `render/sky.ts` gave three reasons for `renderOrder -1000` with
 * `depthTest: false`, and every one of them survives the change — which is why
 * it could become the default rather than a preset flag:
 *
 *   *"drawn first, never occluding"* — with `depthWrite` off and z pinned to
 *   the far plane, a `LEQUAL` test passes only where the depth buffer is still
 *   at its cleared 1.0, i.e. where nothing was drawn. It cannot occlude.
 *
 *   *"needing no far-plane budget, which is why its radius is arbitrary"* —
 *   pinning z makes the radius MORE arbitrary, not less: the dome's own depth
 *   stops being consulted at all. `SKY_RADIUS` is 1000 against a `CAMERA_FAR`
 *   of 6000, so the dome is physically INSIDE the island and the ocean; that is
 *   exactly why simply turning `depthTest` on without the pin would be wrong,
 *   and is the trap this function exists to not fall into.
 *
 *   *"nothing in it ever z-fights the terrain"* — it writes no depth and its
 *   own depth is the maximum. There is nothing to fight with.
 *
 * What it BUYS was a question for the measurement and is now an answer: the
 * dome is a `MeshBasicMaterial` with vertex colours, about the cheapest
 * fragment in the frame, and §10.3 bracketed it at 0.25–0.38 ms of full-screen
 * overdraw. Drawn last it pays only for the pixels the world did not cover, and
 * wave 4 §3.5 measured **-0.18 to -0.25 ms p50 on four missions across three
 * environments**, including the two with no ocean at all.
 *
 * ── Which way the COMPILE now falls ──────────────────────────────────────
 *
 * It has flipped with the default. The pin is an `onBeforeCompile` plus
 * `SKY_FAR_PIN_DEFINE`, both installed at construction, so the program the
 * warm-up builds under the curtain IS the pinned one and the shipped frame
 * never compiles a dome in the air. It is the **OFF arm** that compiles now —
 * removing the define is a new key, with no warmed variant and none possible,
 * because warming a program the game never draws with is what DEV-177(b)
 * measured as building the wrong one. Throw the arm, let a frame or two pass,
 * then bracket; the A-B-A makes a forgotten settle visible as two A rows that
 * disagree.
 */
export const setSkyLast = (dome: THREE.Object3D | null, on: boolean): SkyLastReport => {
  const none: SkyLastReport = {
    moved: 0,
    seen: 0,
    on: false,
    renderOrder: 0,
    depthTest: false,
    depthWrite: false,
    pinned: false,
  }
  if (dome === null) return none
  const mesh = dome as THREE.Mesh
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    | THREE.Material
    | undefined
  if (!material) return none

  if (!priorSky.has(dome)) {
    priorSky.set(dome, {
      renderOrder: dome.renderOrder,
      depthTest: material.depthTest,
      depthWrite: material.depthWrite,
    })
  }
  const before = priorSky.get(dome) as SkyPriorState

  if (on) {
    chainShaderPatch(
      material,
      {
        tag: 'sky-far-pin',
        vertex: skyFarPinPatch,
        after: (shader) => {
          if (!shader.vertexShader.includes(SKY_FAR_PIN_DEFINE)) {
            throw new Error('draw-order: the sky far-plane pin did not land in the patched shader.')
          }
        },
      },
      pinned,
    )
  }

  // ── the define, moved IN PLACE and in a FIXED position ───────────────
  //
  // three walks `material.defines` with `for...in` (insertion order), so `{A,B}`
  // and `{B,A}` are two cache keys for one shader, and a name that leaves and
  // comes back lands at the END. That made the ocean's key a function of the
  // flight's HISTORY rather than of its STATE and cost a 318 ms compile in the
  // air (DEV-194). This module owns exactly one name. `setDefineInPlace` adds it
  // at the end and removes it without disturbing the rest, which is the order
  // the old rebuild produced ("everything that is not ours, in the order it was
  // already in, then ours") without replacing the defines OBJECT, which
  // `fragment-gates.ts` keys its state on (DEV-238). The position of the pin is
  // a function of the state on any route in, including a flip to the OFF arm
  // and back inside one flight.
  let moved = 0
  if (setDefineInPlace(material, SKY_FAR_PIN_DEFINE, on)) {
    material.needsUpdate = true
    moved++
  }
  const wantOrder = on ? SKY_LAST_ORDER : before.renderOrder
  const wantTest = on ? true : before.depthTest
  const wantWrite = on ? false : before.depthWrite
  if (dome.renderOrder !== wantOrder) {
    dome.renderOrder = wantOrder
    moved++
  }
  if (material.depthTest !== wantTest) {
    material.depthTest = wantTest
    moved++
  }
  if (material.depthWrite !== wantWrite) {
    material.depthWrite = wantWrite
    moved++
  }
  return {
    moved,
    seen: 1,
    on,
    renderOrder: dome.renderOrder,
    depthTest: material.depthTest,
    depthWrite: material.depthWrite,
    pinned: Object.hasOwn((material.defines ?? {}) as Record<string, unknown>, SKY_FAR_PIN_DEFINE),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Switch 3 — the vehicle FIRST among the world's opaques (DEFAULT, DEV-246)
// ─────────────────────────────────────────────────────────────────────────

/**
 * The `renderOrder` the COCKPIT FIRST default puts on the vehicle's opaque,
 * depth-writing geometry.
 *
 * -1, not -1000: the only thing it has to beat is the terrain's 0, and three
 * compares `renderOrder` before `material.id`, so any negative number is the
 * whole of the change. Staying next to 0 is the same reasoning
 * `OCEAN_LATE_ORDER` gives for 1 from the other side, and it leaves the band
 * below free for anything that ever has to precede the ship.
 *
 * **`render/medal.ts` also writes -1**, on `holder`, and the two do not
 * interact: it is set on a GROUP, which three does not inherit
 * (`projectObject` pushes each drawable with its OWN `renderOrder`), so that
 * shell's meshes are at 0 whatever the holder says — DEV-241 §5b is the row
 * that found it. Even if it were ever fixed onto the meshes, a medal is in the
 * menu room and a cockpit is in a mission, and both would be opaque geometry
 * early in the same band, which is not a conflict.
 */
export const COCKPIT_FIRST_ORDER = -1

// There is deliberately NO `COCKPIT_LATE_ORDER` beside it, for
// `OCEAN_LATE_ORDER`'s reason: the vehicle's meshes are built at three's own
// default and `setCockpitFirst(group, true)` records that in `cockpitPrior`
// before it moves them, so the OFF arm restores what the constructor made
// rather than a number written down twice (trap 24).

/** What a vehicle mesh's order was before this switch touched it. */
const cockpitPrior = new WeakMap<THREE.Object3D, number>()

export interface CockpitFirstReport extends DrawOrderReport {
  /** Drawables under the group this switch is not allowed to move. */
  readonly skipped: number
}

/**
 * Is this drawable one the switch may pin ahead of the world?
 *
 * Four conditions, and each of them is a way the pin would be a PICTURE bug
 * rather than a no-op. The first three are the exact inverse of DEV-241 §5's
 * dome condition — *an opaque object submitted before the dome must write
 * depth* — arriving from the other end of the frame:
 *
 *   **opaque.** three keeps two render lists and draws every opaque before
 *   every transparent, so a transparent mesh's `renderOrder` orders it only
 *   against other transparents. The HUD (10), the briefing (10), the results
 *   plate (11), the pause plate (12) and the perf plate (11) are a deliberate
 *   STACK, and moving one of them to -1 would put it under the others rather
 *   than early in the frame.
 *
 *   **writes depth.** An opaque mesh drawn before the terrain that does not
 *   write depth is simply painted over by the terrain behind it — it
 *   disappears. Drawn late, as today, it depth-tests and wins where it is
 *   nearer. This is the condition `render/medal.ts`'s shell fails (opaque,
 *   `depthWrite: false`), and it is the reason the filter is a property of the
 *   material rather than a list of names.
 *
 *   **depth-tests.** A mesh with `depthTest: false` always draws, so its
 *   position in the sequence is the whole of what it looks like: late it
 *   paints over the world, early the world paints over it.
 *
 *   **nobody has ordered it.** A `renderOrder` that is not three's default is
 *   somebody's decision, and this switch exists precisely because the
 *   vehicle's position today is NOT one. Once a mesh is in `cockpitPrior` it
 *   is ours and this test no longer applies, which is what makes re-asserting
 *   idempotent.
 */
const cockpitEligible = (object: THREE.Object3D, materials: readonly THREE.Material[]): boolean => {
  if (materials.length === 0) return false
  if (object.renderOrder !== 0) return false
  for (const material of materials) {
    if (material.transparent) return false
    if (!material.depthWrite) return false
    if (!material.depthTest) return false
  }
  return true
}

/** Every material on a drawable, as a flat list. */
const materialsOf = (object: THREE.Object3D): THREE.Material[] => {
  const m = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined
  if (!m) return []
  return (Array.isArray(m) ? m : [m]).filter(Boolean)
}

/**
 * Draw the player's vehicle BEFORE the world it is flying over.
 *
 * **`on` is the DEFAULT since DEV-246** and `false` is the A/B arm.
 * `game/flight.ts` and `game/jumpseat-flight.ts` call this with `true` on the
 * group they have just built — and `flight.ts` calls it again from
 * `setInterior`, because the cabin is LAZY and a mesh born after the switch
 * would arrive at three's default.
 *
 * ── Matt's question, and why the answer was "already true, by accident" ──
 *
 * *"If ordering matters, would it make sense to draw the cockpit before the
 * environment so the pixels it blocks aren't drawn?"* — 2026-09-20. The
 * principle is DEV-238's and it is right: fill the depth buffer with near
 * opaque geometry first and early-Z rejects what is behind it.
 *
 * Measured before anything moved (`tests/e2e/draw-order-cockpit.spec.ts`), the
 * vehicle was already mostly early — and by nothing anybody chose. three sorts
 * opaques `groupOrder → renderOrder → material.id → materialVariant → z`, so
 * with every renderOrder at 0 the sequence is the order two materials were
 * CONSTRUCTED in. On both HoverJet missions that split the group in two:
 *
 *   * the first-person hull and the next-gate arrow at index 5 / 6, before the
 *     terrain — the accident landing the right way up;
 *   * **the cockpit INTERIOR at 323 / 132** — the seat, the pilot's body and
 *     the control stick, 21 draws, after the terrain, the props, the dressing,
 *     the clouds, the horizon, the start grid, the launch anchor and the
 *     racers. Every one of them opaque, depth-writing and at `renderOrder` 0.
 *
 * The JumpSeat is already one run at the head of the colour pass, so on
 * `adv_02_jumpSeat` this switch cannot move anything and is the negative
 * control: its A/B arm must read zero.
 *
 * **What the frame gains is bounded and the bound is measured.** Wave 4's
 * queue F hid the whole `jumpseat` group on `adv_02_jumpSeat` and the frame
 * got *slower* by 0.25 ms p50 — `VR-PERF-WAVE-4.md` §3.5 f-03, *"the seat no
 * longer occludes the near field"*. That 0.25 ms is the vehicle's ENTIRE
 * occlusion contribution on that mission, already banked. This switch moves
 * only the part of it that is currently late, so 0.25 ms is a ceiling and not
 * a prediction. Most of what this is worth is that the order stops being an
 * accident: one new material, or a different load order, and the hull lands
 * behind the island with nobody noticing.
 *
 * ── Re-asserting is free, and the lazy cabin needs it to be ──────────────
 *
 * Idempotent, every mesh, every call, exactly as `setOceanLate` is: `moved`
 * counts what THIS call changed and `seen` what it owns. A mesh built after
 * the call — the cabin body, the pilot, the stick, all of which
 * `render/cockpit-interior.ts` constructs only when a preset asks — is picked
 * up by the next re-assert. That is also why an OFF arm has to be re-asserted
 * on every poll: an edition flip rebuilds the body and the new meshes arrive
 * at the DEFAULT, which would leave a median that is a mixture with no name.
 * `xr-vrto3d-trace.spec.ts` already re-asserts every order arm for exactly
 * that reason (DEV-241 §7).
 *
 * `seen` is the count of drawables this switch OWNS, not of drawables under
 * the group. An arm reads `seen === 0` as ARM DID NOT FIRE, and a report of
 * `seen: 26, moved: 0` on a group whose 26 drawables were all ineligible would
 * be a dead arm wearing a live one's clothes. `skipped` carries the rest so
 * the picture is still complete — DEV-238 §5's `moved`/`carrying` separation,
 * in a third place.
 */
export const setCockpitFirst = (group: THREE.Object3D | null, on: boolean): CockpitFirstReport => {
  if (group === null) return { moved: 0, seen: 0, skipped: 0, on: false }
  let moved = 0
  let seen = 0
  let skipped = 0
  group.traverse((object) => {
    if (
      !(object as THREE.Mesh).isMesh &&
      !(object as THREE.Object3D & { isBatchedMesh?: boolean }).isBatchedMesh
    ) {
      return
    }
    if (!cockpitPrior.has(object)) {
      if (!cockpitEligible(object, materialsOf(object))) {
        skipped++
        return
      }
      cockpitPrior.set(object, object.renderOrder)
    }
    seen++
    const want = on ? COCKPIT_FIRST_ORDER : (cockpitPrior.get(object) as number)
    if (object.renderOrder === want) return
    object.renderOrder = want
    moved++
  })
  return { moved, seen, skipped, on }
}
