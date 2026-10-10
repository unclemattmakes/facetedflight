// src/render/mode-mark.ts — the FLIGHT PLAN, on the flight-plan table (DEV-354).
//
// Matt, 2026-09-24, after playing the build: *"mode select - this should be a
// single rotating ring/gate for ring attack, a single jump pad for target
// practice. a single orb for free flight."* And of the step after it: *"level
// select - show terrain diorama, no gates. (this was a previous
// misunderstanding i think on both our counts)"*.
//
// ── What the misunderstanding was ─────────────────────────────────────────
//
// DEV-313 answered *"holotable dioramas should be representative of their
// MODE"* by changing the COURSE tables: a Ring Attack course dropped its island
// and became a circuit of gates, a Target Practice course lobbed a JumpSeat
// between red-and-white targets. So the mode was said twice below the step that
// chose it — in the header, and again in every course's picture — while the
// step whose whole question IS the mode (2016's `- Select a Flight Plan -`)
// stood one course's island under the word: a picture of a PLACE, answering a
// question about a GAME. The fix is a swap. The flight-plan step says the plan,
// with one thing; the level step says the land (`render/diorama.ts`).
//
// ── What this file is ─────────────────────────────────────────────────────
//
// A display case, and `render/holo-ship.ts`'s sibling one step down: hand it a
// kind of mark and its geometry, get back one model sized to stand on a
// holotable, turning. It loads nothing — the gate and the orb arrive through
// `hangar.gates()` / `hangar.orbs()` as the aircraft arrive through `ships()`,
// and the pad is lathed from a level's own pad surface — because the room is
// built synchronously and a GLB is not.
//
// ── The kind is read off the MODE'S OWN ROW, never off its name ───────────
//
// {@link modeMarkKind} asks `scores(mode, kind)` — the predicate the HUD's count
// and `game/mission-shape.ts`'s `missionTour` already ask — in that file's
// `OBJECTIVE_ORDER`. `game/modes.ts`'s standing rule is that nothing outside it
// asks *"is the mode freeFlight?"*, and this does not: a fourth mode that scores
// rings (`energyRace` is one, offered by no shipped mission yet) stands a gate
// with no code change.
//
// ── The art is the WORLD'S, material and all ──────────────────────────────
//
//   gate  {@link gateMarkGeometry}: `checkpoint-ring.glb` through
//         `gateFramePose`, the world's own frame chain, in `ringFrameMaterial()`
//         — the very material `loadRings` hangs on the gate you fly through.
//   pad   `buildPadGeometry(solid)`, in `padMaterial()` — `loadPads`'s own.
//   orb   {@link orbMarkGeometry}: `energy-orb.glb` through `orbArtGeometry`,
//         in `orbMaterial()` — `loadOrbs`'s own.
//   instructor  (DEV-379, where the mode TEACHES) the aircraft's own hull in
//         the lesson's colour, {@link instructorHull}, stood through
//         `holo-ship.ts` — the racers' paint on the aircraft table's model.
//
// **LIT, which the table's old marks were not, and the size is why.** At 20-34
// mm a mark on a course table was a symbol, below a pixel of shading, and
// `MeshBasicMaterial` was right for it. At a fifth of a metre it is a MODEL, and
// an unlit ball is a flat pale-green disc: the facets — ART_DIRECTION's pillar 2,
// one colour per face — are only there if light falls on them. The aircraft step
// already solved lighting a model on a holotable in a dark room (DEV-142,
// DEV-188): two lamps a table, built with the ROOM and never removed, aimed by
// `holoShipLamps`. A mark reports the same pair, and adds no light of its own —
// so the scene's light count, which is in every lit program's cache key, does
// not move when a step changes.
//
// ── The size, and what is left for Matt to call ───────────────────────────
//
// The caller gives a cylinder — a swept DIAMETER and a HEIGHT — and the mark is
// scaled to the largest size that fits both. One rule for three shapes that
// share nothing: the gate is wide and open, the pad is a flat dish, the orb is
// a ball. What each comes to on a 0.26 m-rim table is in `render/hangar.ts`
// beside the two numbers, and DEV-354's row; both numbers and the spin rate are
// taste, and Matt's to move.

import * as THREE from 'three'
import type { GameMode } from '@/content/level-schema'
import { OBJECTIVE_ORDER } from '@/game/mission-shape'
import { type CollectibleKind, rulesFor, scores } from '@/game/modes'
import { orbArtGeometry, orbMaterial } from '@/game/orb-art'
import { padMaterial } from '@/game/pad-art'
import { bakedGeometry, gateFramePose, ringFrameMaterial } from '@/game/rings'
import {
  createHoloShip,
  HOLO_SHIP_FRONT,
  HOVER_FRACTION,
  type HoloShipLamp,
  holoShipLamps,
  SPIN_DEG_PER_SECOND,
} from './holo-ship'
import { paintLivery, type Srgb } from './racer-livery'
import { disposeTree } from './scene-walk'
import { turntableYaw } from './turntable'

/**
 * What a flight-plan table can stand: a thing the mode scores, or — where the
 * mode TEACHES — the instructor (DEV-379).
 */
export type ModeMarkKind = CollectibleKind | 'instructor'

/**
 * Which mark a flight-plan table stands: the kind the mode SCORES, read off its
 * row in `MODES`, in `OBJECTIVE_ORDER`. Null for a mode that scores nothing —
 * no shipped mode — which stands no mark rather than a wrong one.
 *
 * **Except where the mode teaches (DEV-379).** Flight School scores rings —
 * the HUD counts them and the arrow points at the next — so the rule above
 * would stand Ring Attack's gate on its table, and two plans on one arc would
 * say the same thing. What a lesson HAS that no other plan has is the
 * instructor, so that is its mark: the instructor's hull, turning
 * (`docs/plan/FLIGHT-INSTRUCTOR.md` §7). Asked of `teaches`, the one question
 * the mode row answers for everything that treats a lesson differently — never
 * of the row's name.
 */
export const modeMarkKind = (mode: GameMode): ModeMarkKind | null =>
  rulesFor(mode).teaches
    ? 'instructor'
    : (OBJECTIVE_ORDER.find((kind) => scores(mode, kind)) ?? null)

/**
 * What each kind is CALLED on the table, for the mesh name and for anything
 * reading the scene from outside. The words a player would use, not the scorer's
 * (`padZone` is a zone of a pad; the thing on the table is the pad).
 */
export const MARK_NAMES: Readonly<Record<ModeMarkKind, string>> = {
  ring: 'gate',
  padZone: 'pad',
  orb: 'orb',
  instructor: 'instructor',
}

/**
 * The gate MARK: 2016's gate frame, posed exactly as the world poses it, then
 * centred on its opening and scaled to ONE unit tall. DEV-326, moved here from
 * `render/diorama.ts` by DEV-354 with the gates themselves.
 *
 * `root` is the loaded `checkpoint-ring.glb`. `bakedGeometry` keeps its node
 * transform (the dropped 90-degree X rotation that once laid every gate flat)
 * and `gateFramePose` is `game/rings.ts`'s own frame chain — the roll that makes
 * a gate WIDE, and `jumpGate_diamond`'s offset and 3.885 scale — so the mark
 * cannot come out in a different orientation from the gate you fly through: it
 * is the same function. `checkpoint-ring-asset.test.ts` measures it against the
 * RAW baked extents, so a dropped roll (the gate on end, 0.69 instead of 1.45)
 * goes red.
 *
 * Centred on the bounding box, because the frame's own origin is the prefab's,
 * offset from its opening (`jumpGate_diamond` sits at (-0.069, 0.359, 0.014)
 * inside it). **Normals are KEPT** since DEV-354: the mark is lit, and the
 * world's frame material has no `flatShading` to derive them from. A uniform
 * scale leaves them unit length. UVs are dropped; nothing samples a texture.
 *
 * Null when the GLB has no mesh in it.
 */
export const gateMarkGeometry = (root: THREE.Object3D): THREE.BufferGeometry | null => {
  const geometry = bakedGeometry(root)
  if (!geometry) return null
  geometry.applyMatrix4(gateFramePose())
  geometry.computeBoundingBox()
  const box = geometry.boundingBox as THREE.Box3
  const centre = box.getCenter(new THREE.Vector3())
  const height = box.max.y - box.min.y
  geometry.translate(-centre.x, -centre.y, -centre.z)
  if (height > 0) geometry.scale(1 / height, 1 / height, 1 / height)
  geometry.deleteAttribute('uv')
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/**
 * The orb MARK: 2016's orb, posed exactly as the world poses it
 * (`orbArtGeometry`, the same function, so the table cannot turn it some other
 * way), centred and scaled to ONE unit of RADIUS. DEV-327, moved here from
 * `render/diorama.ts` by DEV-354.
 *
 * Radius rather than height because it is a ball: every vertex of the mesh is
 * the same distance from its centre, so "how far it reaches" is one number
 * whichever way it is turned. Normals are kept, as the gate's are; the orb's
 * material shades flat either way. Null when the GLB has no mesh in it.
 */
export const orbMarkGeometry = (root: THREE.Object3D): THREE.BufferGeometry | null => {
  const geometry = orbArtGeometry(root)
  if (!geometry) return null
  geometry.computeBoundingBox()
  const centre = (geometry.boundingBox as THREE.Box3).getCenter(new THREE.Vector3())
  geometry.translate(-centre.x, -centre.y, -centre.z)
  const position = geometry.getAttribute('position')
  let reach = 0
  for (let i = 0; i < position.count; i++) {
    reach = Math.max(reach, Math.hypot(position.getX(i), position.getY(i), position.getZ(i)))
  }
  if (reach > 0) geometry.scale(1 / reach, 1 / reach, 1 / reach)
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}

/** The world's own material for each kind. A new one per mark, which the mark frees. */
const markMaterial = (kind: CollectibleKind): THREE.Material =>
  kind === 'ring' ? ringFrameMaterial() : kind === 'padZone' ? padMaterial() : orbMaterial()

const SPIN = (SPIN_DEG_PER_SECOND * Math.PI) / 180

/** DEV-575: the first step's own pictures, which no flight plan stands. */
export type DoorMarkKind = 'formation' | 'tv' | 'scroll' | 'options' | 'editor' | 'roll'

export interface ModeMark {
  /**
   * Add this to the table group, at the table's model plane. Its origin is the
   * spin axis at that plane, and it does NOT itself turn — the mark hangs on a
   * spinner inside it, so the lamps can stay still while it goes round, as the
   * aircraft's do. Named `mode-mark`, with `userData.kind` the scorer's kind.
   */
  readonly object: THREE.Group
  /**
   * A flight plan's kind, or (DEV-575) a first-step door's own picture:
   * MULTIPLAYER's three-jet formation or FF-TV's set (`render/door-marks.ts`).
   */
  readonly kind: ModeMarkKind | DoorMarkKind
  /** The two lamps this mark wants, in {@link object}'s frame. See `HoloShipLamp`. */
  readonly lamps: { readonly key: HoloShipLamp; readonly fill: HoloShipLamp }
  /** The radius of the disc it sweeps as it turns, metres. */
  readonly reach: number
  /** Its drawn height, lowest vertex to highest, metres. */
  readonly height: number
  /** Its lowest point, metres above {@link object}'s origin. */
  readonly bottom: number
  /**
   * DEV-574: the spinner yaw that turns its FRONT to its object's +z: 0 for a
   * gate, whose face looks along z at a yaw of 0 (the gate's own test reads it
   * wide in x there), and for the round orb and pad; an aircraft's half turn
   * for the instructor (`HoloShip.front`).
   */
  readonly front: number
  /** DEV-574: rest at this spinner yaw while its table is not selected. See `HoloShip.rest`. */
  rest(yaw: number): void
  /** Turn it while `spinning` (the default), or ease it to rest. See `HoloShip.update`. */
  update(seconds: number, spinning?: boolean): void
  /**
   * Free the MATERIAL, which is this mark's own. The geometry is BORROWED —
   * the room owns the gate, the orb and each pad it has lathed, shares one of
   * each with every table that wants it, and frees them itself.
   */
  dispose(): void
}

/**
 * The mark every one-model table shares past its measuring: a {@link ModeMark}
 * over a spinner group, resting and turning by `turntableYaw` at the aircraft's
 * own rate, lamps for the swept diameter, front at yaw 0. The caller has built
 * `object` (holding `spinner`) and measured `reach`, `height` and `bottom`, and
 * says what `dispose` frees, because that is the one thing the marks differ in
 * (a borrowed geometry is not theirs to free). Reuse audit, last clones.
 */
export const spinnerMark = (parts: {
  readonly kind: ModeMark['kind']
  readonly object: THREE.Group
  readonly spinner: THREE.Object3D
  readonly reach: number
  readonly height: number
  readonly bottom: number
  readonly dispose: () => void
}): ModeMark => {
  const { object, kind, spinner, reach, height, bottom, dispose } = parts
  let restYaw: number | null = null
  return {
    object,
    kind,
    lamps: holoShipLamps(2 * reach, bottom),
    reach,
    height,
    bottom,
    front: 0,
    rest(yaw: number) {
      restYaw = yaw
      spinner.rotation.y = yaw
    },
    update(seconds: number, spinning = true) {
      spinner.rotation.y = turntableYaw(spinner.rotation.y, restYaw, seconds, spinning, SPIN)
    },
    dispose,
  }
}

/**
 * Stand one mark on a table: `geometry` (borrowed) in the world's own material
 * for `kind`, scaled to the largest size whose swept disc is at most `sweep`
 * metres across and whose height is at most `tall`, floating over the table as
 * the aircraft does, and turning as the aircraft does.
 *
 * Everything is read off the geometry's own bounding box and vertices, not off
 * a belief about where its origin is — the gate mark is centred on its opening,
 * the orb on its middle, and a lathed pad has its origin on the collider's
 * surface — so the three share one line on the table whatever their authors did
 * (`holo-ship.ts`'s rule, for the same reason).
 */
export const createModeMark = (
  kind: CollectibleKind,
  geometry: THREE.BufferGeometry,
  sweep: number,
  tall: number,
): ModeMark => {
  const object = new THREE.Group()
  object.name = 'mode-mark'
  object.userData.kind = kind
  const spinner = new THREE.Group()
  spinner.name = 'mode-mark-spinner'
  object.add(spinner)

  // ── measure, then size ──────────────────────────────────────────────────
  //
  // The swept disc is about the vertical through the box's centre, because that
  // is the axis it will turn about once centred. `max(…, 1e-9)` so a geometry
  // that resolved to nothing gives a scale of 0, not an Infinity that writes
  // NaN into the scene graph.
  const box = new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute,
  )
  const centre = box.getCenter(new THREE.Vector3())
  const position = geometry.getAttribute('position')
  let swept = 0
  for (let i = 0; i < position.count; i++) {
    swept = Math.max(swept, Math.hypot(position.getX(i) - centre.x, position.getZ(i) - centre.z))
  }
  const rawHeight = box.max.y - box.min.y
  const scale = Math.min(sweep / Math.max(2 * swept, 1e-9), tall / Math.max(rawHeight, 1e-9))
  const reach = swept * scale
  const height = rawHeight * scale
  // The aircraft's hover, a twelfth of its span, so the three steps float their
  // models alike. The SWEPT diameter stands in for the span: a mark is turned
  // through every heading, and that is the width it has on the table.
  const bottom = 2 * reach * HOVER_FRACTION

  const mesh = new THREE.Mesh(geometry, markMaterial(kind))
  mesh.name = `mode-mark-${MARK_NAMES[kind]}`
  mesh.scale.setScalar(scale)
  mesh.position.set(-centre.x * scale, bottom - box.min.y * scale, -centre.z * scale)
  spinner.add(mesh)

  // A random start, like the aircraft and the medals: a page of marks turning
  // in lockstep reads as one object drawn several times.
  spinner.rotation.y = Math.random() * Math.PI * 2

  return spinnerMark({
    object,
    kind,
    spinner,
    reach,
    height,
    bottom,
    dispose() {
      spinner.remove(mesh)
      ;(mesh.material as THREE.Material).dispose()
    },
  })
}

/* ═══════════════════ the instructor, on Flight School's table (DEV-379) ═══ */

/**
 * The instructor's HULL: the aircraft's own model, its livery repainted in the
 * lesson's colour (`lesson.instructor.colour`, `#e9f3f5` on both canyon
 * lessons: Matt's call 5, *"read as not a racer"*). The paint is the racers'
 * own (`paintLivery`, DEV-350), so the table stands the colour the instructor
 * wears in the air, on the hull the aircraft table stands.
 *
 * A PROTOTYPE, for {@link createInstructorMark} to borrow: the room builds one
 * per aircraft and colour and frees it. Every mesh gets its OWN geometry
 * before the paint goes on, because `paintLivery` sets the new colour
 * attribute on the geometry it finds, and `clone(true)` shares geometry with
 * the source — so without the copy the aircraft table's hull would turn
 * white-teal too (trap 19: one object, two owners). The materials stay
 * shared: the colour is per vertex, and the program is the one the aircraft
 * table already compiled.
 */
export const instructorHull = (prototype: THREE.Object3D, colour: Srgb): THREE.Object3D => {
  const hull = prototype.clone(true)
  hull.position.set(0, 0, 0)
  hull.rotation.set(0, 0, 0)
  hull.scale.set(1, 1, 1)
  hull.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh) mesh.geometry = mesh.geometry.clone()
  })
  paintLivery(hull, colour)
  hull.updateMatrixWorld(true)
  return hull
}

/** Free what {@link instructorHull} made: its geometries, never the shared materials. */
export const disposeInstructorHull = (hull: THREE.Object3D): void =>
  disposeTree(hull, { materials: false })

/**
 * Stand the instructor on a Flight School table: `hull` (borrowed, from
 * {@link instructorHull}) through `render/holo-ship.ts` — the aircraft's own
 * display case, so it turns, hovers and is lit exactly as the aircraft on the
 * aircraft step — sized by the flight-plan marks' one rule: the largest that
 * fits `sweep` across and `tall` high.
 *
 * Named `mode-mark` with `userData.kind` `instructor`, like every mark, and
 * NOT `holo-ship-…`: the room's census (`ship-select.spec.ts`) counts aircraft
 * by that prefix, and a plan table stands a mark, not an aircraft to pick.
 */
export const createInstructorMark = (
  hull: THREE.Object3D,
  sweep: number,
  tall: number,
  /**
   * DEV-575: what the hull IS, for the census: the instructor, or MULTIPLAYER's
   * formation of three (`render/door-marks.ts`), which stands on the same
   * display case.
   */
  kind: 'instructor' | 'formation' = 'instructor',
  /** DEV-574: the hull's nose, as `aircraftFront` says it for the aircraft it is. */
  front: number = HOLO_SHIP_FRONT,
): ModeMark => {
  // Measured as `createHoloShip` measures its clone — at identity, by its box —
  // so the diameter handed over is exactly the one that fits both bounds.
  const size = new THREE.Box3().setFromObject(hull).getSize(new THREE.Vector3())
  const across = 2 * Math.max(Math.hypot(size.x / 2, size.z / 2), 1e-6)
  const diameter = Math.min(sweep, (tall * across) / Math.max(size.y, 1e-9))
  const ship = createHoloShip(hull, kind, diameter, front)
  ship.object.name = 'mode-mark'
  ship.object.userData.kind = kind
  return {
    object: ship.object,
    kind,
    lamps: ship.lamps,
    reach: ship.reach,
    height: size.y * (diameter / across),
    bottom: ship.bottom,
    front: ship.front,
    rest: (yaw: number) => ship.rest(yaw),
    update: (seconds: number, spinning?: boolean) => ship.update(seconds, spinning),
    dispose: () => ship.dispose(),
  }
}
