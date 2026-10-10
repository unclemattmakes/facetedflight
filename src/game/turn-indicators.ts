// src/game/turn-indicators.ts — the chevrons that tell you where the course goes.
//
// These are the markers in Matt's 2016 screenshots that the port did not have,
// and they are not decoration: on a course whose gates are 22 m wide and
// hundreds of metres apart, they are how you know a turn is coming before you
// can see the gate that makes it.
//
// ── They come in TRIOS ────────────────────────────────────────────────────
//
// `int_01_hoverJet` places nine, and they are not spread along the route — they
// sit in three tight clusters of three, one per turn:
//
//     (1) (2) and the unnamed root   x ~ 1238..1285, z ~   649..891
//     (3) (4) (5)                      x ~  301..472, z ~ -1786..-1848
//     (6) (7) (8)                      x ~ -823..-640, z ~  893..978
//
// So a turn reads as a run of arrows sweeping round rather than as one sign.
// That is also why they are kept in AUTHORED order rather than sorted by
// distance along the route: the trio order is the reading order.
//
// Every hoverJet mission has them (9 here, 12 in `rookie_01`, 27 in `int_02`)
// and **no JumpSeat mission does** — all six carry zero. They are a HoverJet
// feature, which fits: the JumpSeat is a launcher, not a racer.
//
// ── A turn indicator is a gate, unrolled ──────────────────────────────────
//
// Both of its material guids resolve to the checkpoint ring's own materials:
// `checkpoint_enabled.mat` on the arrow, `glowyMaterial.mat` on the bars. That
// is not a coincidence to paper over — it means every correction already made
// to the gate applies here for free, and it means this file must NOT re-derive
// those numbers. `props.checkpointRing` is where they live; the extractor
// asserts the identity (`arrowMaterialIsRingFrame`, `barMaterialIsRingStud`)
// so that if a future extraction ever finds a third material, a test fails
// instead of a colour quietly drifting.
//
// So: the arrow is translucent green at `_GlowStrength` 0.25, and the four bars
// are OPAQUE with `_GlowStrength` 2. The bars are the bright part. Same as the
// gate, where the studs are the bright part and the frame is what they hang in.
//
// ── The one thing that is easy to get wrong ───────────────────────────────
//
// The four bars are children of `turnIndicator_art (2)`, which is scaled
// **non-uniformly** by (5.13, 4.87, 3.08) — and the bars are each rotated about
// z by ±35..37°. A rotation underneath a non-uniform parent scale is a SHEAR.
// Flatten the hierarchy into one TRS per bar and the chevron's bars come out
// the wrong shape: subtly, plausibly, and wrong.
//
// The fix is to not flatten. Matrix multiplication reproduces Unity's hierarchy
// exactly, and `unityPose`'s flip survives the composition because the
// handedness flip is a conjugation — see the note on it in
// `render/unity-space.ts`.
//
// ── The SECOND thing that is easy to get wrong (DEV-198) ──────────────────
//
// `turnIndicator_art (2)`'s own rotation is not a constant. The sheet records
// the PREFAB's — identity — and two of the thirteen shipped scenes override it
// per instance, on the child, with `m_Modifications`: `rookie_02_hoverJet` on
// all 21 placements and `adv_01_hoverJet` on 6 of 21, both Mesa Canyon, both
// yawing the sign ~86–90° about its own Y (three of rookie_02's roll 90° about
// X as well). Nowhere else does it at all.
//
// Read only the root's pose, as this file did for four sessions, and those 27
// chevrons stand BROADSIDE to the course — face-on to a player who is about to
// fly past them, arrow pointing across the line of flight instead of along it.
// The arithmetic is unambiguous: dot(arrow forward, course tangent) is 0.83–1.00
// for all 87 untouched markers and −0.46..0.24 for all 27 of these, and applying
// the override moves every one of the 27 to 0.83–1.00 and moves none of the 87.
//
// This is hard rule 2 in the place nobody looks for it. The rule says a `public`
// field's initialiser is not shipped behaviour and you must trace
// scene → prefab → value → `m_Modifications`; what is easy to miss is that the
// modification can target a node INSIDE the prefab rather than the root you
// placed. `level.turnIndicators[i].art` is that node, and it is Unity-space and
// prefab-local — the same space as the sheet's entry, not the three-space world
// pose that `pos`/`quat` beside it are.

import * as THREE from 'three'
import { assetUrl } from '@/content/asset-url'
import type { Level, TurnIndicator } from '@/content/level-schema'
import { PROPS } from '@/generated/constants.generated'
import { loadMesh } from '@/render/load-mesh'
import { unityPose } from '@/render/unity-space'
import { bakedGeometry, drawAsGateFrame, ringFrameMaterial, ringStudMaterial } from './rings'

const INDICATOR_MESH = 'assets/props/turn-indicator.glb'

/**
 * The arrow node's pose, three-space: the scene's if it re-aimed it, otherwise
 * the prefab's.
 *
 * Both branches are Unity-space TRS triples going through the one `unityPose`,
 * so there is no second convention to get wrong — see the DEV-198 note in the
 * header for why the branch exists at all.
 *
 * Exported because it is what `turn-indicator.test.ts` sweeps: the test flies
 * the SHIPPED composition against the course polyline rather than re-deriving
 * it, which is the difference between testing this file and agreeing with it.
 */
export const turnIndicatorArtPose = (
  placement: Pick<TurnIndicator, 'art'>,
  out: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 => {
  // The sheet's key, imported rather than restated — `hoverjet.input.controlScheme`
  // said `"a"` with `trust: verified` for four sessions while the shipped layout
  // was something else, because nothing read it.
  const arrow: {
    position: readonly number[]
    rotation: readonly number[]
    scale: readonly number[]
  } = placement.art ?? PROPS.turnIndicator.arrow
  return unityPose(arrow.position, arrow.rotation, arrow.scale, out)
}

export interface LoadedTurnIndicators {
  readonly object: THREE.Object3D
  readonly count: number
  dispose(): void
}

export const loadTurnIndicators = async (level: Level): Promise<LoadedTurnIndicators> => {
  const placements = (level.turnIndicators ?? []).filter((t) => t.live)
  const spec = PROPS.turnIndicator

  const gltf = await loadMesh(assetUrl(INDICATOR_MESH))
  const geometry = bakedGeometry(gltf.object)
  if (!geometry) throw new Error('turn-indicator.glb has no mesh')

  // The gate's own two materials, from the gate's own factories (XC-17: this
  // file held a character-for-character copy of both). `drawAsGateFrame` below
  // turns the frame's depth write on (DEV-422).
  const arrowMaterial = ringFrameMaterial()
  const barMaterial = ringStudMaterial()

  const arrows = new THREE.InstancedMesh(geometry, arrowMaterial, Math.max(placements.length, 1))
  arrows.name = 'turn-indicator-arrows'
  arrows.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  arrows.frustumCulled = false
  // The "arrow" in Matt's *"draw order on ring and arrow material"*: this
  // material IS the ring frame's, and every chevron on a course is one
  // instanced object sorted as one point, as the rings are. Same fix, same
  // reason — `rings.ts`'s DEV-422 note.
  drawAsGateFrame(arrows)

  const bars = new THREE.InstancedMesh(
    // A unit box. Every bar's real size is in its own scale, and the mesh
    // reference in the prefab is Unity's BUILT-IN cube (fileID 10202) — there
    // is no asset to load, which is why the sheet records `builtinMesh` rather
    // than a null `mesh` that would look like a missing file.
    new THREE.BoxGeometry(1, 1, 1),
    barMaterial,
    Math.max(placements.length * spec.bars.length, 1),
  )
  bars.name = 'turn-indicator-bars'
  bars.instanceMatrix.setUsage(THREE.StaticDrawUsage)
  bars.frustumCulled = false

  // NOT flattened into the art pose — see the header. Each stays a separate
  // matrix so the shear the non-uniform parent scale imposes on a rotated child
  // is reproduced rather than approximated.
  const barPoses = spec.bars.map((bar) => unityPose(bar.position, bar.rotation, bar.scale))

  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const world = new THREE.Matrix4()
  const artPose = new THREE.Matrix4()
  const art = new THREE.Matrix4()
  const scratch = new THREE.Matrix4()
  let slot = 0

  placements.forEach((placement, i) => {
    const p = placement.pos as number[]
    const q = placement.quat as number[]
    const s = placement.scale as number[]
    position.set(p[0] as number, p[1] as number, p[2] as number)
    quaternion.set(q[0] as number, q[1] as number, q[2] as number, q[3] as number)
    scale.set(s[0] as number, s[1] as number, s[2] as number)
    // The level JSON is already three-space: `readTurnIndicators` converts the
    // WORLD pose on the way out, so only the prefab-local parts need flipping.
    world.compose(position, quaternion, scale)
    // Per indicator, not once for all of them: 27 of the 114 carry their own
    // arrow rotation (DEV-198).
    art.multiplyMatrices(world, turnIndicatorArtPose(placement, artPose))

    arrows.setMatrixAt(i, art)
    for (const pose of barPoses) {
      bars.setMatrixAt(slot++, scratch.multiplyMatrices(art, pose))
    }
  })
  arrows.instanceMatrix.needsUpdate = true
  bars.instanceMatrix.needsUpdate = true

  const group = new THREE.Group()
  group.name = 'turn-indicators'
  group.add(arrows)
  group.add(bars)

  return {
    object: group,
    count: placements.length,
    dispose() {
      arrows.dispose()
      bars.dispose()
      bars.geometry.dispose()
      arrowMaterial.dispose()
      barMaterial.dispose()
      gltf.dispose()
    },
  }
}
