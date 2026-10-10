// src/render/holo-ship.ts — the AIRCRAFT, on the aircraft table (DEV-142).
//
// Matt, in a headset, first playthrough: *"menu ui showing ship selection
// should show the ships, not terrain, on the holo table."*
//
// He is describing a screen that was already documented as doing this.
// `game/mission-index.ts` has said since DEV-105 that *"the new first screen is
// two aircraft and **no height map** — the tables carry ships"*, and it was the
// argument for regrouping the whole menu: a page of courses costs two or three
// height maps where the old environment page cost one, and the step in front of
// it was supposed to pay that back by costing none. It never carried a ship.
// `slotShapeId` handed an aircraft slot **its first course's id**, and both
// aircraft begin at `rookie_01_*`, so the opening screen was the alpine island
// twice, 195–969 KB of height map, under two different words. The marks — rings
// on one table, landing pads on the other — were bolted on precisely because
// the two islands were identical and something had to tell them apart. That
// note is the tell, read the wrong way round: the fix for two identical islands
// was never to distinguish the islands.
//
// 2016 agrees, and more plainly: `page_shipSelection` is a page of SHIPS.
//
// ── What this file is, and is not ────────────────────────────────────────
//
// It is a display case: hand it a ship model, get back one sized and lifted to
// stand on a 0.50 m holotable, turning. It loads nothing — the models arrive
// through `hangar.ships()` the way the parked jet arrives through `park()` and
// the medals through `medals()`, because the room is built synchronously and a
// GLB is not.
//
// ── Orientation: measured, not asserted ──────────────────────────────────
//
// The orientation lesson says to test the GEOMETRY, not the rotation — *"a
// distance or an aspect ratio is true independently of what you believed; a
// quaternion assertion is your belief written twice"* — and this file is built
// so there is no belief to write down. It applies **no rotation of its own but
// a turntable about the vertical**, which is the one axis a wrong answer on
// costs nothing: the model comes round. Everything else is read off the mesh —
// the scale from the bounding box, the lift from the box's own floor — so the
// two aircraft can disagree about where their origin is, and both still stand
// on the table rather than through it or above it.
//
// That the models are UPRIGHT at identity is not this file's assumption
// either. It is `render/hangar.ts`'s `parkShip`, which puts the HoverJet on the
// floor with `rotation.set(0, PARKED_SHIP_YAW, 0)` and nothing else, swept
// against twelve frames (DEV-139); and `game/jumpseat-art.ts`, whose rig is
// *"identity rotation and unit scale on every link"* off the shipped prefab.
// Both are already in the room, both already look right there.

import * as THREE from 'three'
import { turntableYaw } from './turntable'

/**
 * How far the ship floats over the table top, as a fraction of its own length.
 *
 * Both aircraft fly, and a hologram of one resting on a plinth reads as a
 * model kit. A twelfth of its length is enough to see under at the 24° the
 * seat looks down at the table from (`hangar.ts`'s `HOLO_REACH`), and small
 * enough that the JumpSeat's feet still read as the lowest thing on the table.
 */
export const HOVER_FRACTION = 1 / 12

/**
 * Degrees per second. The medals' own rate (`PROPS.medals.spinDegPerSecond`,
 * 2016's), halved.
 *
 * Halved because a medal is 0.08 m and a ship is 0.36 m, and the same angular
 * rate on a body four times the size is four times the retinal motion — in a
 * headset, on a thing you are being asked to look at and read. One turn in
 * thirteen seconds is slow enough to study and fast enough that a glance never
 * catches the same face twice.
 *
 * Exported, with {@link HOVER_FRACTION}, because the flight-plan table's mark is
 * the same kind of display case one step down (`render/mode-mark.ts`, DEV-354):
 * a model the same size, turning at the same rate, over the same table.
 */
export const SPIN_DEG_PER_SECOND = 27.5

const SPIN = (SPIN_DEG_PER_SECOND * Math.PI) / 180

/**
 * DEV-574: the spinner yaw that points an aircraft's nose along +z, for a mesh
 * exported in three space with its nose on -z (the JumpSeat's assemblies,
 * `game/jumpseat-art.ts`: no yaw anywhere in its rig): a half turn. See
 * `HoloShip.front`, and {@link aircraftFront} for the hull that differs.
 */
export const HOLO_SHIP_FRONT = Math.PI

/**
 * DEV-574: the HoverJet hull's nose is its GLB's **+x**, not -z: the mesh is
 * symmetric in z (the beam) and asymmetric in x (fore and aft), and the flight
 * turns it nose-to--z with `SHIP_MODEL_YAW` (+90 degrees, `game/flight.ts`).
 * So the yaw that puts the nose on +z is that plus a half turn: -90 degrees.
 * `hangar-tables.test.ts` holds it against `SHIP_MODEL_YAW`, and the first
 * photographs of DEV-574 are why: with `HOLO_SHIP_FRONT` the resting jets
 * stood side-on and MULTIPLAYER's formation flew sideways.
 */
export const HOVERJET_HULL_FRONT = -Math.PI / 2

/**
 * Which way an aircraft's model faces, by the id the room stands it under.
 * The glider stands in the HoverJet's hull (DEV-399, `boot/app.ts`'s
 * `ships()`), so it faces the same way; anything else is a three-space
 * assembly ({@link HOLO_SHIP_FRONT}).
 */
const HULL_FRONTS: Readonly<Record<string, number>> = {
  hoverjet: HOVERJET_HULL_FRONT,
  glider: HOVERJET_HULL_FRONT,
}

/** DEV-574: the spinner yaw that turns aircraft `vehicle`'s nose to +z. */
export const aircraftFront = (vehicle: string): number => HULL_FRONTS[vehicle] ?? HOLO_SHIP_FRONT

/**
 * One of the two lamps an aircraft on a holotable wants — WHAT to set, not a
 * light.
 *
 * It is a description rather than a `PointLight` because of DEV-188: a light
 * that comes and goes with the ship changes the SCENE's `numPointLights`, which
 * is a field of every lit material's program cache key, and the room then
 * recompiles its materials on the first press. So `render/hangar.ts` owns a
 * fixed pair of lamps per table for the room's whole life and this says where
 * to put them and how bright. Nothing here adds a light to anything.
 *
 * `position` is in the {@link HoloShip.object}'s own frame — the spin axis at
 * the ship's floor — so the caller places the pair wherever it put the ship.
 */
export interface HoloShipLamp {
  readonly color: number
  readonly intensity: number
  readonly distance: number
  readonly decay: number
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface HoloShip {
  /**
   * Add this to the table group. Its origin is the spin axis at the table top,
   * and it does NOT itself turn — the model hangs on a spinner inside it, so
   * the key light can stay still while the aircraft goes round. A light that
   * turned with the model would light the same face for ever, which is a
   * turntable that shows you one side.
   */
  readonly object: THREE.Group
  /**
   * The two lamps this aircraft wants, in {@link object}'s frame. The caller
   * sets its own fixed pair from them; see {@link HoloShipLamp}.
   */
  readonly lamps: { readonly key: HoloShipLamp; readonly fill: HoloShipLamp }
  /** Which aircraft it is, for anything reading the scene from outside. */
  readonly vehicle: string
  /**
   * The radius of the disc the model sweeps as it turns, metres — the
   * footprint to keep inside the rim. `render/medal.ts` calls the same
   * quantity `reach`, for the same reason: it is the one horizontal size that
   * does not change with the yaw.
   */
  readonly reach: number
  /** The model's longest horizontal extent after scaling, metres. */
  readonly span: number
  /** The lowest point of the model, metres above the object's origin. */
  readonly bottom: number
  /**
   * DEV-574: the spinner yaw that turns the model's FRONT (an aircraft's nose)
   * to its object's +z. The room adds it to the yaw that faces the seat.
   */
  readonly front: number
  /**
   * DEV-574: where it rests while its table is not the selected one, as a
   * spinner yaw (radians). Puts it there at once, too: a picture is laid at
   * rest, never mid-turn.
   */
  rest(yaw: number): void
  /**
   * Turn it while `spinning` (the default, as it always did); otherwise ease it
   * back to its rest (`render/turntable.ts`, DEV-574). Render time, not sim
   * time: this is decoration.
   */
  update(seconds: number, spinning?: boolean): void
  /**
   * Drop the clone.
   *
   * Geometries and materials are **shared with the prototype** — this is a
   * `clone()`, three's own shallow one — so they are emphatically not disposed
   * here. The prototype outlives every table that borrows it and is disposed
   * with the room; a page turn that disposed them would take the ship away
   * from the OTHER aircraft's table, and then from itself on the way back.
   *
   * Nor are there any lights to drop. That is the whole of DEV-188 —
   * see {@link HoloShipLamp}.
   */
  dispose(): void
}

/**
 * Where this aircraft's key and fill go, and how bright.
 *
 * ── the key light ─────────────────────────────────────────────
 *
 * Because the first build of this was a black silhouette on a lit table, and
 * *a thing that is too dark has not been reviewed, it has been rendered*
 * (orientation lesson §5c). Everything else the room stands on a holotable —
 * the island, the rings, the pads, the tiny jets — is `MeshBasicMaterial`,
 * UNLIT, which is why it reads in a room this dark. An aircraft is not: both
 * come with lit materials, and the menu room's only lamp is up at the wall
 * top, metres above and behind the tables.
 *
 * A POINT light with a short `distance`, so it is a light on this table and not
 * a second lamp in the room: it dies well before the next table, 30 degrees
 * round the arc.
 *
 * Outside the spinner, so the model turns through a fixed light instead of
 * carrying its own round with it and lighting one face for ever.
 *
 * ** The intensities are DERIVED, because the first pair were guessed and
 * blew both aircraft out to white.** With `decay: 2` the illuminance at the
 * surface is `intensity / d²`, and d here is a third of a metre — so an
 * intensity that sounds small is enormous. 2.4 at 0.3 m is 26 units against a
 * room lamp delivering about 1.4 to the same table (`PointLight(_, 90, _, 2)`
 * some 8 m up the wall), which is 18x, which is a silhouette replaced by a
 * flare. Everything below is solved for a KEY of about 3 units — enough to
 * lift a dark hull off a dark room, about twice what the room itself gives —
 * and a fill a quarter of that.
 *
 * Pure, and exported, so the numbers can be asserted without a room, a GLB or
 * a GL context.
 *
 * @param span   the model's longest horizontal extent after scaling, metres.
 * @param bottom how far its floor floats above the table top, metres.
 */
export const holoShipLamps = (
  span: number,
  bottom: number,
): { readonly key: HoloShipLamp; readonly fill: HoloShipLamp } => {
  const keyOffset = span * 0.7
  const keyDistance = span * 3
  // `d²` for a light offset by `offset` on all three axes, undoing three's
  // distance window at that range so the units asked for are what lands.
  const solve = (units: number, offset: number): number => {
    const d2 = 3 * offset * offset
    const window = (1 - (d2 * d2) / (keyDistance * keyDistance * keyDistance * keyDistance)) ** 2
    return (units * d2) / Math.max(window, 0.05)
  }
  return {
    key: {
      color: 0xffe6c4,
      intensity: solve(3, keyOffset),
      distance: keyDistance,
      decay: 2,
      x: keyOffset,
      y: bottom + keyOffset,
      z: keyOffset,
    },
    // A dim fill from the other side, or the far half of every aircraft is the
    // same black it was before.
    fill: {
      color: 0xbfe6ec,
      intensity: solve(0.75, span * 0.8),
      distance: keyDistance,
      decay: 2,
      x: -span * 0.8,
      y: bottom + span * 0.45,
      z: -span * 0.8,
    },
  }
}

/**
 * Stand `prototype` on a table, sized so the disc it turns inside is
 * `sweptDiameter` metres across.
 *
 * The SWEPT DISC and not the longest axis, because the two aircraft have
 * completely different footprints. Measured off the shipped GLBs,
 *
 *     hoverjet-exterior   6.82 x 2.01 x 6.17   near-square, it is a delta
 *     jumpseat assembly   1.32 x 2.38 x 5.85   narrow, and TALLER than long
 *
 * so a rule phrased as "36 cm along its longest axis" put the HoverJet's
 * corners 0.243 m out against a `TABLE_RIM_RADIUS` of 0.26 — 93 % of the rim,
 * grazing it twice a turn — and the JumpSeat's at 0.192. One number, two
 * different-looking tables, on the one screen whose whole job is to compare
 * them. Sizing the disc makes "it fits" a property of the rule rather than a
 * fact about today's two meshes, and gives both aircraft the same presence.
 *
 * The caller passes the diameter rather than a fraction of one, so the number
 * that decides it can be the rim's own (`TABLE_RIM_RADIUS * 2`) and this file
 * needs no constant of its own to reconcile with `hangar.ts`'s.
 *
 * The prototype is cloned, so one loaded mesh serves every table that wants it
 * and the caller keeps ownership of what it loaded.
 */
export const createHoloShip = (
  prototype: THREE.Object3D,
  vehicle: string,
  sweptDiameter: number,
  /** DEV-574: the spinner yaw that turns its nose to +z (`aircraftFront`). */
  front: number = HOLO_SHIP_FRONT,
): HoloShip => {
  const object = new THREE.Group()
  object.name = `holo-ship-${vehicle}`
  // The half that turns. See `HoloShip.object`.
  const spinner = new THREE.Group()
  spinner.name = `holo-ship-spinner-${vehicle}`
  object.add(spinner)

  const model = prototype.clone(true)
  // Whatever the loader left on it. A ship parked in the room may have been
  // yawed by its own placement, and a display case starts from the mesh.
  model.position.set(0, 0, 0)
  model.rotation.set(0, 0, 0)
  model.scale.set(1, 1, 1)
  model.updateMatrixWorld(true)

  // The box is measured BEFORE the scale is applied and everything below is
  // derived from it, so this function has no opinion about how big either
  // aircraft is — which is the whole reason the JumpSeat needed no second set
  // of numbers when it arrived.
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())

  // The swept disc of the box once it is centred on the axis — see
  // `SHIP_TABLE_FRACTION` for why this and not the longest axis. The vertical
  // is deliberately not in it: an aircraft with a tall fin is not a wider
  // aircraft, and shrinking it for one would push the other two axes off the
  // table for nothing.
  //
  // `max(…, 1e-6)` so an empty prototype — a load that resolved to nothing —
  // gives a scale of 0 rather than an Infinity that writes NaN into the scene
  // graph and takes the whole table's subtree with it.
  const sweptRadius = Math.max(Math.hypot(size.x / 2, size.z / 2), 1e-6)
  const scale = sweptDiameter / (sweptRadius * 2)
  const reach = sweptRadius * scale
  const span = Math.max(size.x, size.z) * scale
  const bottom = span * HOVER_FRACTION

  // Centre it on the spin axis horizontally, and put its own FLOOR at the
  // hover height. Reading the floor off the box rather than assuming the
  // origin is at it is what lets the HoverJet (origin at its hull centre) and
  // the JumpSeat (origin at the rigidbody, 1.4 m above its feet) share a line.
  model.scale.setScalar(scale)
  model.position.set(-centre.x * scale, bottom - box.min.y * scale, -centre.z * scale)
  spinner.add(model)

  // A random start, like the medals: four tables turning in lockstep looks
  // like one object drawn four times.
  spinner.rotation.y = Math.random() * Math.PI * 2

  // ── the two lamps, described and NOT created ─────────────────────────────
  //
  // `holoShipLamps` says where they go and how bright; `render/hangar.ts` owns
  // the actual `PointLight`s, one fixed pair per table, for the room's whole
  // life. The reasoning is DEV-188 and it is the reverse of what this file used
  // to say. It used to read *"it is created with the ship rather than with the
  // room ... so the scene's light COUNT changes exactly when a ship is added or
  // dropped — a page turn, not a frame"*, offered as the mild version of the
  // cost. It is the expensive version: `numPointLights` is a field of every lit
  // material's program cache key, a change to it bumps `WebGLLights`'
  // `state.version`, and that is the branch of `needsProgramChange` which
  // re-fetches a program for every lit material in the frame. Measured on the
  // walk a player takes: **four programs on the first press in the room.**
  //
  // So this function adds no lights at all, which is a property a test can
  // hold. `tests/unit/holo-ship.test.ts` holds it.

  let restYaw: number | null = null
  return {
    object,
    vehicle,
    reach,
    span,
    bottom,
    lamps: holoShipLamps(span, bottom),
    front,
    rest(yaw: number) {
      restYaw = yaw
      spinner.rotation.y = yaw
    },
    update(seconds: number, spinning = true) {
      spinner.rotation.y = turntableYaw(spinner.rotation.y, restYaw, seconds, spinning, SPIN)
    },
    dispose() {
      spinner.remove(model)
    },
  }
}
