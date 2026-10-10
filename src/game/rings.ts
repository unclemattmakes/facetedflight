// src/game/rings.ts — the course, as geometry you can fly at.
//
// One ring mesh, instanced. `int_01_hoverJet` places 21 of them at scale 2, and
// every shipped mission is in the same range, so this is `InstancedMesh`
// territory: one draw call for the whole course instead of 21.
//
// ── Which rings are real ──────────────────────────────────────────────────
//
// The level JSON already carries only the LIVE ones. That distinction matters
// more than it sounds: a ring counts only with `m_Enabled: 1`, a non-zero
// `addScore`, and an entire `m_Father` chain that is active. Skip the walk and
// `int_02` reports 77 rings instead of 21, and `adv_02` 68 instead of 28 — the
// scene files are full of disabled duplicates from authoring.
//
// So nothing here filters anything. If a ring is in the JSON it is in the
// course, and if that is ever wrong the bug is in the extractor.
//
// ── A gate is not one mesh ────────────────────────────────────────────────
//
// `checkpoint-ring.glb` is only ONE of the gate's parts — `jumpGate_diamond` —
// and it arrives wearing whatever material the FBX carried. Matt's 2016
// screenshots show a bright GREEN translucent hexagonal frame with lighter
// studs around it.
//
// ── Three things that were wrong here, and what each cost ─────────────────
//
// Matt, on the first screenshots: "your rings aren't the same jump gate things
// i was using". They were not, in three separate ways:
//
//  1. **The asset was a different mesh.** `checkpoint-ring.glb` held `pPipe1`,
//     a 100-vertex 72-triangle Maya pipe from some other file — a thin flat
//     torus. The real gate is `jumpGate_00_noPosRot:polySurface16`: 1,698
//     vertices, 908 triangles, a chunky hexagonal frame. Fixed at source
//     (`tools/assets/convert-fbx.py`), which now checks the exported size
//     against a number cross-checked three ways off the prefab.
//
//  2. **The glTF node transform was discarded.** `firstMesh()` took
//     `mesh.geometry` and dropped the node's 90-degree X rotation, which is
//     what stands the ring UP. The gate was rendering flat, like a puddle. It
//     is baked in here now.
//
//  3. **The frame's prefab transform was never applied.** `jumpGate_diamond`
//     sits at (-0.069, 0.359, 0.014) and is **scaled 3.885** inside the
//     prefab. The 18 studs carry their own transforms and were correct, so the
//     frame rendered at a quarter size inside a full-size stud cage.
//
// The lesson is (1): the asset had the right filename, was the right rough
// shape, and was 100% wrong. CLAUDE.md's rule about tracing provenance applies
// to meshes, not only to numbers.
//
// `Prefabs/Checkpoint_Ring.prefab` is 34 objects: the diamond with
// `checkpoint_enabled.mat`, **18 cubes** with `glowyMaterial.mat`, seven
// `ringBurst` particle systems, three trigger colliders and a tree remover.
//
// Both materials use a third-party Marmoset shader, so FF2 writes its own —
// but the NUMBERS travel, and they are in the sheet: the frame is
// (0.325, 1.0, 0.059) at 0.709 alpha, the studs near-white with a teal glow.
// The studs are plain boxes, so they are rebuilt from the 18 extracted
// transforms with no new asset at all.
//
// ── Orientation ───────────────────────────────────────────────────────────
//
// A ring is a gate, so its facing is load-bearing: fly through the plane, not
// past it. The quaternion comes from the level JSON already converted to three
// space, and it has to be applied as-is — re-deriving a facing from "point at
// the next ring" would look right on a straight course and wrong on every turn.
//
// ── A passed gate goes away (DEV-122) ─────────────────────────────────────
//
// 2016 removed a gate two seconds after the PLAYER flew through it —
// `TriggerCheckpoint.Deactivate()` on the `offset` node both parts hang under.
// The port never did, and every gate stood for the whole run. `game/gate-
// visibility.ts` holds the rule (when, how fast, player-only, any order); this
// file only rewrites two instance matrices from the scale it returns. The sim
// is untouched: `sim/course.ts` still tests every trigger, for racers and
// ghosts as much as for you, whatever this draws.
//
// Since DEV-195 the Anniversary shrink starts on the trigger's EXIT edge rather
// than its entry, because the entry is ~22 m before the gate and the shrink was
// happening inside the crossing. The exit is READ from the sim's own
// `CourseState.inside[]` and is not measured again here — see `update`.
//
// ── The finish gate (DEV-123) ─────────────────────────────────────────────
//
// For the whole life of the port the finish was an invisible 68.59 m sphere.
// 2016 drew one, and it is in the level JSON now (`finish.art`, extracted):
// the SAME `jumpGate_diamond` mesh at world scale 23.56 — three times a
// ring's 7.77 — wearing `checkpoint_finish.mat` (ORANGE, where a ring is
// green) inside a cage of **40** `glowyMaterial` cubes where a ring has 18.
// The 2016 gameplay video shows exactly that at 3:30: an orange frame sitting
// past the last green ring. No new asset; a second material off the sheet and
// forty more boxes. Because the frame is the ring's own geometry, every
// correction the ring has ever needed — the baked node transform, the mirror,
// the material colour space — applies here for free, and a fifth orientation
// bug has nowhere to hide: the finish's poses arrive COMPOSED from the
// expanded scene, so there is no pivot chain to drop.
//
// The Anniversary preset adds a silhouette on top of 2016's colour and size:
// `gates.finishBanner`, a chequered band of separated cells along the top
// edge. Pillar 1's black cut-out of the 2016 finish is a nearer ring; with the
// band it is a finish.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import type { EditionFinishBanner, EditionPassedFade } from '@/content/edition-schema'
import { type FinishGateArt, type Level, liveRings, type WorldPose } from '@/content/level-schema'
import { PROPS } from '@/generated/constants.generated'
import { loadMesh } from '@/render/load-mesh'
import { shininessToRoughness } from '@/render/terrain-mesh'
import { srgbToLinear, unityPose } from '@/render/unity-space'
import {
  BULLSEYE_INSTANCES,
  bullseyePoses,
  cleanRadius,
  type GateBullseyeSpec,
} from './gate-bullseye'
import { createGateVisibility, passedFadeSpec } from './gate-visibility'

/** The gate frame's asset. Exported so the holotable loads the same file (DEV-326). */
export const RING_MESH = 'assets/props/checkpoint-ring.glb'

// ── DEV-422: where a gate's TRANSLUCENT parts sit in the frame ────────────
//
// Matt, 2026-09-26: *"check draw order on ring and arrow material - it seems
// to draw on top of other things?"* The ring frame and the turn indicator's
// arrow wear one material, 2016's `checkpoint_enabled`: translucent, and built
// with `depthWrite` off. Against the terrain, the props and the ship that was
// always right: they are opaque, drawn before any translucent thing, and write
// depth, and a gate behind a ridge was hidden in every adversarial frame taken.
//
// Against every OTHER translucent thing it was decided by the wrong point.
// three draws its transparent list back to front by ONE point per object, and
// an `InstancedMesh` sorts at its instances' bounding-sphere centre, so all of
// a course's frames sorted as one point in the middle of the course, wherever
// the gate on screen was. Unity sorted each gate as its own renderer; batching
// 21 of them into one draw is the port's, and it is what lost the order. With
// neither side writing depth, whichever drew second painted over the other:
// photographed, the orange finish frame 237.6 m past `int_01`'s last ring ran
// over that ring's green bars wherever the two crossed.
//
// Two properties make the order right whatever point three sorts by, and they
// cost no draw call:
//
//  1. the gates draw FIRST among the world's translucent things — below
//     three's default order of 0, which racer holograms, ghosts, wing trails
//     and falling prop pieces keep (particles are at 10 and motes at 9 already);
//  2. they WRITE DEPTH. So a translucent thing drawn after a gate is hidden
//     where a bar is in front of it and drawn over the bar where it is in front
//     — and a gate behind another gate is hidden by the nearer one's bars
//     whichever of the two three puts first.
//
// What that gives up is the 29 % of a thing BEHIND a bar that showed through
// it. The bar is 71 % opaque, so that is the smaller error, and it is the
// right way round: nothing farther can now paint over a gate.
//
// `renderOrder` orders only within the transparent list — three draws every
// opaque first — so this moves nothing opaque, and neither property is in
// three's program cache key, so it compiles nothing. The look is untouched:
// `ringFrameMaterial` is still the one description of it, and the flight-plan
// table's mark (DEV-354) keeps that material exactly as it was; this is the
// MISSION's draw policy, applied where a gate is placed in the world.

/** The gates' place in the transparent list: before three's default of 0. */
export const GATE_FRAME_ORDER = -1

/**
 * Draw a translucent gate part — a ring frame, the finish frame, a turn
 * indicator's arrow — first among the world's translucent things, and let it
 * write depth. See the DEV-422 note above.
 */
export const drawAsGateFrame = (mesh: THREE.Mesh): void => {
  mesh.renderOrder = GATE_FRAME_ORDER
  const m = mesh.material
  for (const material of Array.isArray(m) ? m : [m]) material.depthWrite = true
}

// Every ring colour here is a material `Color` property, so every one goes through
// `srgbToLinear` (not for vertex colours: DEV-014).

/** A material `Color` property (sRGB in the sheet) as the linear colour three wants. */
const materialColor = (c: readonly number[]): THREE.Color =>
  new THREE.Color(
    srgbToLinear(c[0] as number),
    srgbToLinear(c[1] as number),
    srgbToLinear(c[2] as number),
  )

/**
 * The gate FRAME's material: `checkpoint_enabled`, translucent and barely lit.
 *
 * `checkpoint_enabled` carries `_ALPHABLEND_ON`, so its 0.709 alpha is real.
 * But its `_GlowStrength` is **0.25** — the frame is not the glowing part of a
 * gate, and the previous 0.9 made it a lantern. Its colours are material
 * `Color`s in a Linear project, so they go through {@link srgbToLinear} (see
 * `loadRings`'s note on colour space).
 *
 * A factory rather than a line inside `loadRings` since DEV-354: the flight-plan
 * table stands ONE gate, large, and it wears this very material rather than a
 * second description of it — two copies of a thing that must stay equal is how
 * the ghosts flew backwards (the orientation lesson, §5). A new material per
 * call, so each owner disposes its own.
 */
export const ringFrameMaterial = (): THREE.MeshStandardMaterial => {
  const ring = PROPS.checkpointRing
  const linear = materialColor
  return new THREE.MeshStandardMaterial({
    color: linear(ring.frameColor),
    emissive: linear(ring.frameGlowColor ?? ring.frameColor),
    emissiveIntensity: ring.frameGlowStrength ?? 0.25,
    roughness: shininessToRoughness(ring.shader, ring.frameSpecular?.shininess ?? 4),
    metalness: 0,
    transparent: ring.frameBlends,
    opacity: ring.frameColor[3] as number,
    // The LOOK's default. A gate placed in a mission is switched to write
    // depth by `drawAsGateFrame` (DEV-422); the flight-plan table's is not.
    depthWrite: false,
    side: THREE.DoubleSide,
  })
}

/**
 * The gate's STUD material: OPAQUE, and the bright thing on the gate.
 *
 * `glowyMaterial` carries an alpha of 0.891 in `_Color` and **no
 * `_ALPHABLEND_ON` keyword**, so that alpha never reached a framebuffer: the
 * studs are opaque. Drawing them at 89% is exactly what made them read faint
 * against the 2016 screenshots.
 *
 * And its `_GlowStrength` is **2**, eight times the frame's 0.25. The studs
 * are what glows on a gate; the frame is the translucent green it hangs in.
 *
 * A factory for the reason `ringFrameMaterial` is one: the turn indicators wear
 * "the gate's own" bars and said so in their header, and a copy of this block
 * there was a second description of a thing that must stay equal (code-reuse
 * audit, XC-17). A new material per call, so each owner disposes its own.
 */
export const ringStudMaterial = (): THREE.MeshStandardMaterial => {
  const ring = PROPS.checkpointRing
  return new THREE.MeshStandardMaterial({
    color: materialColor(ring.studColor),
    emissive: materialColor(ring.studGlowColor),
    emissiveIntensity: ring.studGlowStrength ?? 2,
    roughness: shininessToRoughness(ring.shader, ring.studSpecular?.shininess ?? 4),
    metalness: 0,
    // Opaque. `studBlends` is the material's own `m_ShaderKeywords`, not a guess
    // from the alpha value, and the sheet types it as the literal `false`, so
    // if a future extraction ever flips it TypeScript says so here.
    transparent: ring.studBlends,
    opacity: ring.studBlends ? (ring.studColor[3] as number) : 1,
    depthWrite: !ring.studBlends,
  })
}

export interface LoadedFinishGate {
  /** The frame, `jumpGate_diamond` at the finish's own world pose. */
  readonly frame: THREE.Mesh
  /** The 40 studs, one instanced draw. */
  readonly studs: THREE.InstancedMesh
  /** The Anniversary banner's parent, a child of `frame`. Empty on Classic. */
  readonly banner: THREE.Group
}

export interface LoadedRings {
  readonly object: THREE.Object3D
  readonly count: number
  /**
   * World-space trigger spheres, in course order — the volume the 2016 game
   * actually tested against, not the ring's visual centre. It is offset from
   * the mesh and it is BIG: 22.6 m on the first ring of `int_01`, which is why
   * flying near a ring counts and a tight geometric test would not.
   */
  readonly triggers: { centre: THREE.Vector3; radius: number }[]
  /** The finish gate's objects, or null where the level has no finish art. */
  readonly finish: LoadedFinishGate | null
  /**
   * The AIM RETICLE (DEV-153). Idempotent on an unchanged spec, so `app.ts` may
   * call it every frame; `enabled: false` — and a `cleanCentredness` of 1,
   * which is Classic's — draws nothing at all.
   */
  setBullseye(spec: GateBullseyeSpec, cleanCentredness: number): void
  /**
   * The PLAYER passed ring `index` at sim time `at`. Racers and ghosts never
   * call this — 2016's "npc" branch hides nothing (DEV-122).
   */
  pass(index: number, at: number): void
  /**
   * Advance the passed gates' visuals to sim time `now` under the preset's
   * fade. Cheap when nothing is mid-fade: only a gate whose scale moved is
   * rewritten, and the buffer uploads only on a frame something changed.
   *
   * `inside` is the SIM's own `CourseState.inside[]` — the array `stepCourse`
   * writes the trigger's edges into (DEV-149) — and a passed gate whose entry
   * has gone false is a gate the ship has flown OUT of. Handing it over is what
   * makes the Anniversary fade start when you leave a gate rather than when you
   * enter it (DEV-195); measuring a second distance here instead would be two
   * copies of a containment test that must agree, which is how the ghosts flew
   * backwards.
   *
   * Omit it — a course with no live mission stepping it — and every gate falls
   * back to the pass anchor, which is what `waitForExit: false` does anyway.
   * `EXIT_BACKSTOP_SECONDS` still caps the wait, so a gate cannot be stranded.
   */
  update(now: number, fade: EditionPassedFade, inside?: readonly boolean[]): void
  /** Every gate back to full size. A restarted run rebuilds its course. */
  reset(): void
  /** Build, rebuild or clear the finish banner for this preset. No-op without a finish. */
  setFinishBanner(banner: EditionFinishBanner): void
  dispose(): void
}

/**
 * Pull the single mesh out of a loaded glTF scene, WITH its node transform baked in.
 *
 * The comment that used to stand here claimed the local transform was "baked into the instance
 * matrices so nothing is lost". It was not, and what was lost was the 90-degree X rotation that
 * stands the ring up — Maya authored the pipe lying in its XZ plane. The gates rendered flat.
 *
 * Baking rather than keeping the parent chain is still the right call, because the geometry has to
 * be shared by an `InstancedMesh`; it just has to actually happen.
 */
export const bakedGeometry = (root: THREE.Object3D): THREE.BufferGeometry | null => {
  let found: THREE.Mesh | null = null
  root.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!found && mesh.isMesh) found = mesh
  })
  if (!found) return null
  const mesh = found as THREE.Mesh
  // The whole chain, because the glTF loader puts its own transform on the scene root.
  mesh.updateWorldMatrix(true, false)
  const geometry = mesh.geometry.clone()
  geometry.applyMatrix4(mesh.matrixWorld)
  geometry.computeBoundingSphere()
  geometry.computeBoundingBox()
  return geometry
}

/** A three-space world pose off the level JSON, as a matrix. NOT flipped — the extractor did. */
const worldPoseMatrix = (pose: WorldPose, out = new THREE.Matrix4()): THREE.Matrix4 => {
  const p = pose.pos as number[]
  const q = pose.quat as number[]
  const s = pose.scale as number[]
  return out.compose(
    new THREE.Vector3(p[0] as number, p[1] as number, p[2] as number),
    new THREE.Quaternion(q[0] as number, q[1] as number, q[2] as number, q[3] as number),
    new THREE.Vector3(s[0] as number, s[1] as number, s[2] as number),
  )
}

/** One node of a prefab pivot chain, Unity space, as the sheet carries it. */
interface Pivot {
  readonly position: readonly number[]
  readonly rotation: readonly number[]
  readonly scale: readonly number[]
}

/** A prefab pivot chain, parent first, every pose flipped out of Unity space on the way. */
const pivotChain = (pivots: readonly Pivot[]): THREE.Matrix4 => {
  const out = new THREE.Matrix4()
  for (const pivot of pivots) out.multiply(unityPose(pivot.position, pivot.rotation, pivot.scale))
  return out
}

/**
 * Where the gate FRAME sits inside `Checkpoint_Ring.prefab`, gate-local: the
 * frame's pivot chain — the 90-degree roll that makes a gate WIDE, see the
 * pivot-chain note in `loadRings` — and then `jumpGate_diamond` itself, at
 * (-0.069, 0.359, 0.014) and scaled 3.885. Missing that scale is what once made
 * the frame render at a quarter of the stud cage's size.
 *
 * Exported because the level-select holotable draws this same frame in
 * miniature (DEV-326). Two copies of one composition that must agree is how
 * the ghosts flew backwards (orientation lesson §5), so there is one.
 */
export const gateFramePose = (ring: typeof PROPS.checkpointRing = PROPS.checkpointRing) =>
  pivotChain(ring.framePivots).multiply(
    unityPose(ring.frame.position, ring.frame.rotation, ring.frame.scale),
  )

/**
 * The finish banner's cells, in the FRAME's local space (DEV-123).
 *
 * Pure geometry so it can be tested without a GL context: which cells exist,
 * where, how big, and which are light. The frame's baked geometry is
 * unit-scale, so everything here is divided by the frame's world scale — a
 * 12 m cell on a 23.56x frame is a 0.51-unit box in this space.
 *
 * Cells sit ON the top edge: bottom row at `bbox.max.y + lift`, centred on the
 * frame's x. The band is as deep (z) as a cell is wide, so it reads as blocks,
 * not a card.
 */
export interface BannerCell {
  readonly position: readonly [number, number, number]
  readonly size: number
  readonly light: boolean
}

export const bannerCells = (
  spec: EditionFinishBanner,
  frameBox: THREE.Box3,
  frameScale: number,
): BannerCell[] => {
  const cells: BannerCell[] = []
  if (!(frameScale > 0)) return cells
  const pitch = spec.cellMetres / frameScale
  const size = pitch * (1 - spec.gap)
  const lift = spec.lift / frameScale
  const cx = (frameBox.min.x + frameBox.max.x) / 2
  const cz = (frameBox.min.z + frameBox.max.z) / 2
  for (let r = 0; r < spec.rows; r++) {
    for (let c = 0; c < spec.columns; c++) {
      cells.push({
        position: [
          cx + (c - (spec.columns - 1) / 2) * pitch,
          frameBox.max.y + lift + (r + 0.5) * pitch,
          cz,
        ],
        size,
        light: (r + c) % 2 === 0,
      })
    }
  }
  return cells
}

export const loadRings = async (level: Level): Promise<LoadedRings> => {
  // `liveRings`, and NOT `routes[0].rings` — the SAME expression `game/mission.ts`'s
  // `courseGates` scores, so the drawn gates and the scored gates are one list and index
  // `i` means the same gate in both. They were two derivations of "the course" until
  // DEV-210, and on `adv_01_hoverJet` they disagreed: 22 drawn against 44 scored, so half
  // that mission's gates had no art and DEV-122's fade silently dropped every pass with a
  // course index >= 22 on the bounds check in `createGateVisibility.pass`.
  //
  // Nothing here filters. The extractor decides what the course is, and since DEV-210 it
  // does that with the Curvy spline rather than by taking whichever live ring group sorts
  // first. `tests/unit/course-gate-count.test.ts` holds the two in step for every shipped
  // level, because this is a divergence no amount of testing either side can see.
  const rings = liveRings(level)
  const gltf = await loadMesh(assetUrl(RING_MESH))
  const geometry = bakedGeometry(gltf.object)
  if (!geometry) throw new Error('checkpoint-ring.glb has no mesh')

  const ring = PROPS.checkpointRing

  // ── Colour space, again ────────────────────────────────────────────────
  //
  // Both ring materials use `Marmoset/Illumin/Marmoset Specular IBL.shader`,
  // whose `_Color`, `_GlowColor` and `_SpecColor` are all declared `Color` in
  // its Properties block. In a Linear project Unity converts those on upload, so
  // they arrive linear at the shader. Fourth instance of this class, after the
  // fog, the vertex colours and the terrain tint.
  const linear = (c: readonly number[]) =>
    new THREE.Color(
      srgbToLinear(c[0] as number),
      srgbToLinear(c[1] as number),
      srgbToLinear(c[2] as number),
    )

  // The frame: see `ringFrameMaterial`, which the flight-plan table's gate wears
  // too (DEV-354).
  const frameMaterial = ringFrameMaterial()

  const instanced = new THREE.InstancedMesh(geometry, frameMaterial, Math.max(rings.length, 1))
  instanced.name = 'rings'
  // First among the translucent things, and writing depth (DEV-422): all the
  // course's frames are this ONE object, sorted as one point.
  drawAsGateFrame(instanced)
  // Dynamic since DEV-122: a passed gate's matrix is rewritten while it fades.
  // Between fades nothing is uploaded — `needsUpdate` is set only on a frame a
  // scale actually moved.
  instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  // Every ring is inside the island's bounds; letting three cull the whole
  // instanced mesh by its own bounding sphere is fine, but the default sphere
  // is computed from the SOURCE geometry, which is one ring at the origin.
  instanced.frustumCulled = false

  // ── prefab-local poses ─────────────────────────────────────────────────
  //
  // Both the frame and the studs are placed INSIDE `Checkpoint_Ring.prefab`,
  // and the sheet carries those transforms in UNITY space — that is the rule
  // for everything the extractor reads, so that one flip lives in one place
  // (`render/unity-space.ts`) instead of being scattered through the extractor.
  //
  // So each has to be flipped and then composed with its gate's world matrix.
  // The studs were being composed RAW, which mirrored the cage front-to-back;
  // it is subtle because the arrangement is nearly symmetric in z, which is
  // exactly the kind of nearly-invisible wrong this project keeps finding.

  // ── the pivot chains ───────────────────────────────────────────────────
  //
  // Matt, with a 2016 screenshot: *"right now the gates are 'upright' and should
  // be rotated 90. (they're currently tall and skinny, i want them wide)"*
  //
  // Neither the frame nor the studs is a child of the ring root, and the port
  // composed both straight onto the gate's world matrix. They hang under a node
  // carrying `m_LocalEulerAnglesHint: {x: 0, y: 0, z: 90}` — **a 90-degree
  // roll** — and dropping it is the difference between a gate 24 m wide by 35
  // tall and one 35 by 24. That is the fourth transform in this one prefab to be
  // missed, so the extractor now walks the whole chain and this composes it.
  //
  // Two chains rather than one: the frame hangs off the rolled node directly,
  // the studs off an identity `highlightCubes` beneath it. The net rotation
  // matches; the depth does not, and assuming it did is what the extractor's
  // guard caught on its first run.
  //
  // The level data carries NO per-ring roll — all 21 quaternions read zero on
  // that axis — so this prefab node is the only thing that ever set a gate's
  // aperture, which is why losing it turned every gate in the game on end.
  const studPivot = pivotChain(ring.studPivots)

  // The frame's chain, and `jumpGate_diamond`'s own offset and 3.885 scale on
  // the end of it — see `gateFramePose`, which the holotable shares (DEV-326).
  const framePose = gateFramePose(ring)

  const triggers: { centre: THREE.Vector3; radius: number }[] = []
  // The gate matrices are kept rather than read back off the InstancedMesh: the
  // frame's instance matrix now carries `framePose` too, and the studs need the
  // GATE, not the frame — and DEV-122 recomposes both from them on every fade.
  const gateMatrices: THREE.Matrix4[] = []
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()

  rings.forEach((ring, i) => {
    const p = ring.pos as number[]
    const q = ring.quat as number[]
    position.set(p[0] as number, p[1] as number, p[2] as number)
    quaternion.set(q[0] as number, q[1] as number, q[2] as number, q[3] as number)
    const sc = ring.scale as number[]
    scale.set(sc[0] as number, sc[1] as number, sc[2] as number)
    const gate = new THREE.Matrix4().compose(position, quaternion, scale)
    gateMatrices.push(gate)
    instanced.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(gate, framePose))

    const t = ring.trigger.pos as number[]
    triggers.push({
      centre: new THREE.Vector3(t[0] as number, t[1] as number, t[2] as number),
      radius: ring.trigger.radius,
    })
  })
  instanced.instanceMatrix.needsUpdate = true

  // ── the studs ──────────────────────────────────────────────────────────
  //
  // 18 boxes per gate, 21 gates: 378 instances in ONE draw call. Their
  // transforms are prefab-local, so each is composed with its gate's matrix.
  // The studs: OPAQUE, and the bright thing on the gate. See `ringStudMaterial`.
  const studMaterial = ringStudMaterial()
  // A unit box; every stud's real size is in its own scale. Shared by the ring
  // studs, the finish studs and the finish banner.
  const box = new THREE.BoxGeometry(1, 1, 1)
  const studs = new THREE.InstancedMesh(
    box,
    studMaterial,
    Math.max(rings.length * ring.studs.length, 1),
  )
  studs.name = 'ring-studs'
  studs.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  studs.frustumCulled = false

  // Flipped ONCE, not once per gate: the same 18 poses serve all 21. The pivot
  // chain is folded in here for the same reason — it is constant per prefab.
  const studPoses = ring.studs.map((stud) =>
    new THREE.Matrix4()
      .copy(studPivot)
      .multiply(unityPose(stud.position, stud.rotation, stud.scale)),
  )
  const studWorld = new THREE.Matrix4()
  let slot = 0
  for (const gate of gateMatrices) {
    for (const pose of studPoses) {
      studs.setMatrixAt(slot++, studWorld.multiplyMatrices(gate, pose))
    }
  }
  studs.instanceMatrix.needsUpdate = true

  // ── the aim reticle (DEV-153) ──────────────────────────────────────────
  //
  // Matt: *"makes me [want] 'bullseye target' art inside the gates to show
  // players where to aim."* 2016 drew nothing in the aperture — 19 renderers,
  // all on the rim — so this is Anniversary only and `gate-bullseye.ts` carries
  // the whole argument, including why the radius is the CLEAN rule's own and
  // not a number anybody picked.
  //
  // Built here rather than in its own loader because it wants three things this
  // function already has: the gate matrices, the frame's world pose (for the
  // plane), and `box` + `studMaterial` (so it is the gate's own vocabulary and
  // no new asset is imported). Its own material instance, because its emissive
  // is the spec's and the studs' is the sheet's.
  //
  // The poses are GATE-LOCAL — `gate⁻¹ × world` — for one reason: DEV-122's
  // shrink is `gate × S(s) × pose`, so a reticle stored this way collapses with
  // its gate for free and cannot be left hanging in the air after a pass.
  const bullseyeMaterial = studMaterial.clone()
  bullseyeMaterial.name = 'ring-bullseye'
  const bullseye = new THREE.InstancedMesh(
    box,
    bullseyeMaterial,
    Math.max(rings.length * BULLSEYE_INSTANCES, 1),
  )
  bullseye.name = 'ring-bullseye'
  bullseye.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  bullseye.frustumCulled = false
  bullseye.visible = false
  bullseye.count = 0
  /** Gate-local, `rings.length × BULLSEYE_INSTANCES`. Empty until a spec arrives. */
  let bullseyePosesByGate: THREE.Matrix4[] = []
  let bullseyeKey = ''
  const gateInverse = new THREE.Matrix4()
  const reticleFrame = new THREE.Matrix4()
  const frameRotation = new THREE.Quaternion()
  const framePosition = new THREE.Vector3()
  const frameScale = new THREE.Vector3()
  const setBullseye = (spec: GateBullseyeSpec, cleanCentredness: number) => {
    const key = spec.enabled ? `${JSON.stringify(spec)}|${cleanCentredness}` : ''
    if (key === bullseyeKey) return
    bullseyeKey = key
    bullseyePosesByGate = []
    if (!spec.enabled) {
      bullseye.visible = false
      bullseye.count = 0
      return
    }
    rings.forEach((r, i) => {
      const gate = gateMatrices[i] as THREE.Matrix4
      // The PLANE comes off the frame's own world pose, so the reticle is
      // coplanar with the hole by construction rather than by a rotation
      // somebody derived. The POSITION is the TRIGGER's centre, because
      // `gateCentredness` measures from there and the frame's visual middle is
      // a different point (`trigger_checkpoint` is offset inside the prefab).
      reticleFrame
        .multiplyMatrices(gate, framePose)
        .decompose(framePosition, frameRotation, frameScale)
      const t = r.trigger.pos as number[]
      const world = new THREE.Matrix4().compose(
        new THREE.Vector3(t[0] as number, t[1] as number, t[2] as number),
        frameRotation,
        new THREE.Vector3(1, 1, 1),
      )
      gateInverse.copy(gate).invert()
      for (const pose of bullseyePoses(cleanRadius(r.trigger.radius, cleanCentredness), spec)) {
        bullseyePosesByGate.push(
          new THREE.Matrix4().multiplyMatrices(gateInverse, world.clone().multiply(pose)),
        )
      }
    })
    bullseye.count = bullseyePosesByGate.length
    bullseye.visible = bullseye.count > 0
    bullseyeMaterial.emissiveIntensity = spec.emissive
    const m = new THREE.Matrix4()
    bullseyePosesByGate.forEach((pose, k) => {
      const gate = gateMatrices[Math.floor(k / BULLSEYE_INSTANCES)] as THREE.Matrix4
      bullseye.setMatrixAt(k, m.multiplyMatrices(gate, pose))
    })
    bullseye.instanceMatrix.needsUpdate = true
  }

  const group = new THREE.Group()
  group.name = 'rings'
  group.add(instanced)
  group.add(studs)
  group.add(bullseye)

  // ── the passed gates (DEV-122) ─────────────────────────────────────────
  //
  // Scaling ABOUT THE GATE'S OWN CENTRE: `gate x S(s)` scales in the gate's
  // frame, so the frame and all 18 studs shrink toward the point you flew
  // through rather than toward the world origin two kilometres away. A
  // zero-scale instance is a degenerate triangle set and draws nothing, which
  // is what "gone" means here — no visibility bit to keep in step.
  const visibility = createGateVisibility(rings.length)
  const applied = new Float64Array(rings.length).fill(1)
  const shrunk = new THREE.Matrix4()
  const scaleVec = new THREE.Vector3()
  const scratch = new THREE.Matrix4()
  const applyScale = (i: number, s: number) => {
    const gate = gateMatrices[i] as THREE.Matrix4
    shrunk.copy(gate).scale(scaleVec.set(s, s, s))
    instanced.setMatrixAt(i, scratch.multiplyMatrices(shrunk, framePose))
    const base = i * studPoses.length
    for (let k = 0; k < studPoses.length; k++) {
      studs.setMatrixAt(base + k, scratch.multiplyMatrices(shrunk, studPoses[k] as THREE.Matrix4))
    }
    // The reticle shrinks with its gate (DEV-153 + DEV-122). Same `shrunk`, so
    // it cannot drift out of step — and nothing happens at all while the
    // reticle is off, because `bullseyePosesByGate` is then empty.
    if (bullseyePosesByGate.length > 0) {
      const bBase = i * BULLSEYE_INSTANCES
      for (let k = 0; k < BULLSEYE_INSTANCES; k++) {
        bullseye.setMatrixAt(
          bBase + k,
          scratch.multiplyMatrices(shrunk, bullseyePosesByGate[bBase + k] as THREE.Matrix4),
        )
      }
    }
    applied[i] = s
  }

  // ── the finish gate (DEV-123) ──────────────────────────────────────────
  const finish = buildFinish(level, geometry, box, studMaterial, linear)
  if (finish) {
    group.add(finish.frame)
    group.add(finish.studs)
  }
  let bannerKey = ''
  const bannerMaterials: THREE.Material[] = []
  const clearBanner = () => {
    if (!finish) return
    for (const child of [...finish.banner.children]) {
      finish.banner.remove(child)
      const mesh = child as THREE.InstancedMesh
      mesh.dispose?.()
    }
    for (const m of bannerMaterials) m.dispose()
    bannerMaterials.length = 0
  }

  return {
    object: group,
    count: rings.length,
    triggers,
    finish,
    pass(index, at) {
      visibility.pass(index, at)
    },
    update(now, fade, inside) {
      const spec = passedFadeSpec(fade)
      // The trigger's OTHER edge (DEV-195). `exit` is armed by the pass and
      // takes once, so calling it every frame for every gate that is not
      // currently inside costs 21 array reads and stamps nothing until the
      // frame the ship actually leaves.
      //
      // Indexed by the RENDERER's array, which is `routes[0].rings` while the
      // course is every route flattened — those agree from 0 for every shipped
      // level, and a short `inside` reads as `undefined`, i.e. "not inside",
      // which is the fallback the backstop covers anyway.
      if (inside) {
        for (let i = 0; i < rings.length; i++) {
          if (!inside[i]) visibility.exit(i, now)
        }
      }
      let changed = false
      for (let i = 0; i < rings.length; i++) {
        const s = visibility.scaleAt(i, now, spec)
        if (s === applied[i]) continue
        applyScale(i, s)
        changed = true
      }
      if (changed) {
        instanced.instanceMatrix.needsUpdate = true
        studs.instanceMatrix.needsUpdate = true
        if (bullseyePosesByGate.length > 0) bullseye.instanceMatrix.needsUpdate = true
      }
    },
    reset() {
      visibility.reset()
      let changed = false
      for (let i = 0; i < rings.length; i++) {
        if (applied[i] === 1) continue
        applyScale(i, 1)
        changed = true
      }
      if (changed) {
        instanced.instanceMatrix.needsUpdate = true
        studs.instanceMatrix.needsUpdate = true
        if (bullseyePosesByGate.length > 0) bullseye.instanceMatrix.needsUpdate = true
      }
    },
    setBullseye,
    setFinishBanner(banner) {
      if (!finish) return
      const key = banner.enabled ? JSON.stringify(banner) : ''
      if (key === bannerKey) return
      bannerKey = key
      clearBanner()
      if (!banner.enabled) return
      const frameBox = geometry.boundingBox ?? new THREE.Box3().setFromObject(finish.frame)
      const cells = bannerCells(banner, frameBox, finish.frame.scale.x)
      const light = cells.filter((c) => c.light)
      const dark = cells.filter((c) => !c.light)
      const make = (
        list: BannerCell[],
        colour: readonly number[],
        emissive: number,
        name: string,
      ) => {
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(colour[0] as number, colour[1] as number, colour[2] as number),
          emissive: new THREE.Color(colour[0] as number, colour[1] as number, colour[2] as number),
          emissiveIntensity: emissive,
          roughness: 1,
          metalness: 0,
        })
        bannerMaterials.push(material)
        const mesh = new THREE.InstancedMesh(box, material, Math.max(list.length, 1))
        mesh.name = name
        mesh.count = list.length
        mesh.frustumCulled = false
        const m = new THREE.Matrix4()
        list.forEach((cell, i) => {
          m.compose(
            new THREE.Vector3(cell.position[0], cell.position[1], cell.position[2]),
            new THREE.Quaternion(),
            new THREE.Vector3(cell.size, cell.size, cell.size),
          )
          mesh.setMatrixAt(i, m)
        })
        mesh.instanceMatrix.needsUpdate = true
        return mesh
      }
      finish.banner.add(make(light, banner.light, banner.emissive, 'finish-banner-light'))
      finish.banner.add(make(dark, banner.dark, 0, 'finish-banner-dark'))
    },
    dispose() {
      clearBanner()
      instanced.dispose()
      studs.dispose()
      bullseye.dispose()
      bullseyeMaterial.dispose()
      if (finish) {
        finish.studs.dispose()
        ;(finish.frame.material as THREE.Material).dispose()
      }
      box.dispose()
      frameMaterial.dispose()
      studMaterial.dispose()
      gltf.dispose()
    },
  }
}

/**
 * 2016's finish gate, from `finish.art` (DEV-123). Null where the level has
 * none — the six JumpSeat missions, or a Free Flight course.
 *
 * The frame shares the RING's geometry object and the studs share the ring's
 * stud material: both are the same 2016 assets, and two copies of a thing that
 * must stay equal is how the ghosts flew backwards (the orientation lesson,
 * §5). The one thing that is the finish's own is the frame material, off
 * `PROPS.finishGate` — orange, 0.709 alpha, a warm glow at the ring's 0.25.
 */
const buildFinish = (
  level: Level,
  geometry: THREE.BufferGeometry,
  box: THREE.BufferGeometry,
  studMaterial: THREE.Material,
  linear: (c: readonly number[]) => THREE.Color,
): LoadedFinishGate | null => {
  const finish = level.finish
  if (finish?.shape !== 'sphereUnion' || !finish.art) return null
  const art: FinishGateArt = finish.art
  if (!/jumpGate_diamond\.fbx$/.test(art.frame.mesh)) {
    // The frame is drawn with the ring's geometry, so it had better BE the
    // ring's mesh. A finish that used another one would need another asset.
    console.warn(`finish gate on ${level.id} names ${art.frame.mesh}; drawing jumpGate_diamond`)
  }
  const spec = PROPS.finishGate
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: linear(spec.frameColor),
    emissive: linear(spec.frameGlowColor ?? spec.frameColor),
    emissiveIntensity: spec.frameGlowStrength ?? 0.25,
    roughness: shininessToRoughness(spec.shader, spec.frameSpecular?.shininess ?? 4),
    metalness: 0,
    transparent: spec.frameBlends,
    opacity: spec.frameColor[3] as number,
    // Written as the ring's factory writes it; `drawAsGateFrame` below turns
    // it on, as it does for every gate in a mission (DEV-422).
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const frame = new THREE.Mesh(geometry, frameMaterial)
  frame.name = 'finish-gate'
  // DEV-422: the frame that was photographed painting over the last ring.
  drawAsGateFrame(frame)
  // A WORLD pose in three space, already composed and already flipped by the
  // extractor — set it, do not `unityPose` it. Flipping twice is a mirror.
  worldPoseMatrix(art.frame).decompose(frame.position, frame.quaternion, frame.scale)
  frame.frustumCulled = false

  const studs = new THREE.InstancedMesh(box, studMaterial, Math.max(art.studs.length, 1))
  studs.name = 'finish-gate-studs'
  studs.count = art.studs.length
  studs.frustumCulled = false
  const m = new THREE.Matrix4()
  for (let i = 0; i < art.studs.length; i++) {
    studs.setMatrixAt(i, worldPoseMatrix(art.studs[i] as WorldPose, m))
  }
  studs.instanceMatrix.needsUpdate = true

  const banner = new THREE.Group()
  banner.name = 'finish-banner'
  frame.add(banner)

  return { frame, studs, banner }
}
