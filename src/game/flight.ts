// src/game/flight.ts — the ship, flown.
//
// Owns the vehicle's sim body, its mesh, and the camera that rides in it. The
// flight model itself is `src/sim/hoverjet.ts` or `src/sim/jumpseat.ts` and is
// not touched here: this is the seam that gives it input, reads its pose, and
// puts a camera in the right place.
//
// ── Two vehicles, one seam ────────────────────────────────────────────────
//
// `loadFlight(level)` dispatches on `level.vehicle`. Seven of the thirteen
// shipped missions fly the HoverJet and six fly the JumpSeat, and the two are
// not variants of each other: the JumpSeat is 15 kg with gravity ON and 750 N
// along body **+Y**, no speed chain, no anisotropic bleed, no airbrake, and a
// fuel tank that can run out. `src/sim/jumpseat.ts`'s header has the itemised
// difference. Until this dispatch existed, all six JumpSeat missions flew a
// HoverJet.
//
// Adding a third vehicle is a new `load*Flight` and a new arm here — it is NOT
// a new `Flight` interface, and it must never be a change to `app.ts` (D19).
//
// DEV-399 added the third: the glider (`sim/glider.ts`, DEV-145). It flies in
// the HoverJet's cockpit and hull until it has art of its own, so rather than
// a copy of the HoverJet's loader it is the same loader with the physics
// swapped — {@link Airframe} is the seam, `loadGliderFlight` the arm, and
// `game/glider-flight.ts` everything glider-shaped. `app.ts` did need a few
// additive lines after all (its autopilot, the crash rule, the racers), each
// marked DEV-399.
//
// ── Fixed step, interpolated render ───────────────────────────────────────
//
// The sim runs at 0.0121999998 s (81.967 Hz), the float32 out of 2016's
// `TimeManager.asset`, and never sees a frame delta (D4). The renderer draws
// between the last two sim states. In a headset that gap matters: at 72 Hz the
// display and the sim are not in phase, and drawing the latest sim state
// directly produces a judder that reads as motion sickness rather than as a
// frame-rate problem.
//
// ── Where the camera sits ─────────────────────────────────────────────────
//
// First person, inside the cockpit, which is what the shipped missions render
// (research 05). That is not only faithful — the enclosed cockpit is doing real
// comfort work in VR, one of the five things PORT_PLAN §2.9 counts on. The near
// plane is 0.08 m for the same reason: raise it and the cockpit interior clips,
// which only a worn check can answer.

import * as THREE from 'three'
import { type FlightVariant, STANDARD_FLIGHT_VARIANT } from '@/content/aircraft-schema'
import { assetUrl } from '@/content/asset-url'
import type {
  EditionCockpit,
  EditionCockpitShake,
  EditionHudPlacement,
} from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { HOVERJET } from '@/generated/constants.generated'
import type { FlightActions } from '@/input/actions'
import { type Briefing, createBriefing } from '@/render/briefing'
import { createCockpitInterior } from '@/render/cockpit-interior'
import { setCockpitFirst } from '@/render/draw-order'
import { createHud, type Hud, type HudOptions } from '@/render/hud'
import { placeHudAt } from '@/render/hud-dash'
import { applyLambert1 } from '@/render/lambert1'
import { loadMesh } from '@/render/load-mesh'
import { createNextGateArrow, type NextGateArrow } from '@/render/next-gate-arrow'
import { createPause, type Pause, pausePlateOffset } from '@/render/pause'
import { phoneUi, RESULTS_PHONE_SHIFT_M } from '@/render/phone-floor'
import { LIVERY_PANEL_SRGB } from '@/render/racer-livery'
import { createResults, type Results } from '@/render/results'
import { setColourlessDraw } from '@/render/shadows'
import { applyUnityPose, threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { measureWingTips } from '@/render/wing-trails'
import { type ArtLean, createArtLean, stepArtLean } from '@/sim/art-lean'
import { FIXED_DT } from '@/sim/constants'
import { createHoverMotor, type HoverMotorSpec, stepHoverMotor } from '@/sim/hover-motor'
import {
  createHoverJet,
  type HoverJet,
  type HoverJetSheet,
  hoverJetView,
  noInput,
  stepHoverJet,
} from '@/sim/hoverjet'
import type { HeadPhase } from '@/sim/jumpseat-head'
import type { StrandedPhase } from '@/sim/jumpseat-stranded'
import type { Quat } from '@/sim/math/quat'
import type { Vec3 } from '@/sim/math/vec3'
import type { PropColliders } from '@/sim/props/collision'
import type { RigidBody } from '@/sim/rigidbody'
import type { SpeedChainState } from '@/sim/speed-chain'
import {
  createSurfaceProximity,
  probeSurface,
  type SurfaceProximity,
} from '@/sim/surface-proximity'
import type { HeightField } from '@/sim/terrain/height-field'
import {
  collisionAngularDrag,
  createTerrainCollision,
  hullClearance,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'
import { onPivot, type PointLike, poseArtPivot } from './art-pivot'
import { SHIP_GROUND_CONTACT } from './cockpit-common'
import {
  createShakeEngine,
  createShakeSample,
  readShakeEngine,
  sampleCockpitShake,
  throttleShakeGain,
} from './cockpit-shake'
// DEV-399. Type-only in the other direction, like the JumpSeat's below.
import { gliderAirframe, gliderFor, gliderHudOptions, withGliderSeam } from './glider-flight'
// Type-only in the other direction, so there is no runtime import cycle: this
// module imports the JumpSeat's loader, and that module imports only `Flight`
// and `ShipView` back, both erased at compile time.
import { loadJumpSeatFlight } from './jumpseat-flight'
import {
  type ShipCamera,
  type ShipChase,
  shipCameraFromSheet,
  shipChaseFromSheet,
} from './ship-camera'
import { attachShipWings } from './ship-wings'
import { speedGaugeFullScale } from './speed-gauge'
import { type CraftWingTrails, createCraftWingTrails } from './wing-trails'

export type { ShipCamera } from './ship-camera'

/**
 * The two ship meshes, and which one is worn when.
 *
 * 2016's prefab carries BOTH and toggles them: `Art/FirstPerson` holds
 * `hoverJet_w_cockpit` and is active; `Art/ThirdPerson` holds
 * `hoverJet_exterior_orange` and is `m_IsActive: 0` until the camera goes
 * outside. The ghost's own copy, `playbackGhost/ThirdPerson (1)`, is active —
 * which is why a ghost in 2016 is a solid hull and ours was a cockpit frame.
 *
 * Matt: *"we had a 'third person' model for the hoverjet in the old game, and
 * that's the model i thought the ai/ghost ships + the hoverjet as seen in the
 * menus."* The prefab agrees on all three counts.
 *
 * **They share a frame, and that is measured rather than assumed.** Imported
 * side by side, the two FBXes have identical x bounds (-3.6535..3.1623),
 * identical y bounds (+-3.0827), the same 6.8158 m longest dimension and a
 * matching 12-slab width profile along the fore-aft axis; the exterior is 246
 * verts against the cockpit's 619, the same hull with the interior removed. And
 * `Art/ThirdPerson` carries the SAME -89.988 degree yaw and the same
 * (0.98, 0.98, 0.938) scale as `Art/FirstPerson`. So `ART_POSITION`,
 * `ART_SCALE` and `SHIP_MODEL_YAW` below apply to both, untouched.
 *
 * Named here rather than in each consumer because there were three copies of
 * the cockpit path in three files, which is the drift that sent every ghost in
 * the game flying backwards once already (see `ART_SCALE` below).
 */
const SHIP_MESH = 'assets/ships/hoverjet-cockpit.glb'
export const SHIP_MESH_EXTERIOR = 'assets/ships/hoverjet-exterior.glb'

/**
 * Where the cockpit art sits, and where the eye sits, in the ship's frame.
 *
 * These are two different places and the gap between them is the whole point.
 * The 2016 hierarchy is:
 *
 *   PlayerShip_SR14_Photon        the rigidbody
 *     shipOffset                  (0, -0.17, 0)
 *       CameraRoot_FirstPerson    (0, 1.03, -1.27)  -> world (0, 0.86, -1.27)
 *       Colliders/                the physics hull
 *       art_pivot                 (0, 0.29, -1.16)
 *         Art/FirstPerson         yawed -90 deg, scaled (0.98, 0.98, 0.938)
 *           hoverJet_w_cockpit    -> world (-0.006, -1.031, -1.336)
 *
 * The eye is **1.89 m above the mesh origin**, and — the part that matters —
 * `CameraRoot_FirstPerson` is a child of `shipOffset`, NOT of `art_pivot`. The
 * art hangs off a pivot the camera does not inherit, so when that pivot leans
 * the cockpit rolls around a fixed viewpoint instead of taking the view with
 * it. Matt: "we could not only manoeuvre the entity, but also slightly rotate
 * the ship to loosen the cockpit a bit."
 *
 * The lean IS ported: `sim/art-lean.ts` drives it and `artPivot.rotation` takes
 * it, in Unity degrees converted the same way every other rotation on this ship
 * is — `(-pitch, -yaw, +roll)`, because the handedness flip negates a
 * quaternion's x and y and leaves z alone. (This comment used to say it was not
 * ported. It was, two sessions before the comment was read again.)
 *
 * And it turns the art about `art_pivot`'s OWN point, `ART_PIVOT` below — not
 * about the ship's origin, which is where the port stood the pivot until
 * DEV-365, carrying the whole offset on the art. That is the same place at rest
 * and a different one the moment the pivot turns: the eye is 0.75 m from 2016's
 * pivot and 1.53 m from the origin. `game/art-pivot.ts` has the composition.
 *
 * `Art/ThirdPerson` is INACTIVE in the shipped prefab — and that is the RESTING
 * state of a shipped toggle, not proof the missions were first person only:
 * `CamChanger` on the same prefab swaps it in on CHANGE VIEW (X), with the
 * camera rig reparented to `CamRoot_3rdPerson`. DEV-128, and
 * `hoverjet.camera.*` on the sheet. (This comment used to read the inactive
 * flag as confirmation of research 05. It was the other half of a switch.)
 *
 * All values are UNITY space in the comment and THREE space in the code, so
 * every z is negated. The extractor now walks the camera targets —
 * `hoverjet.camera.firstPerson` is this eye, and
 * `tests/unit/third-person-input.test.ts` holds `EYE` against it. TODO(extract):
 * `ART_POSITION` and `ART_SCALE` still belong there too.
 */
export const EYE = new THREE.Vector3(0, 0.86, 1.27)
export const ART_POSITION = new THREE.Vector3(-0.006, -1.031, 1.336)
/**
 * `shipOffset` (0, -0.17, 0) + `art_pivot` (0, 0.29, -1.16), z negated: the
 * point the lean turns the cockpit about. DEV-365; `tests/unit/art-pivot.test.ts`
 * recomposes it, and `ART_POSITION`, from the prefab. TODO(extract), as above.
 */
export const ART_PIVOT = new THREE.Vector3(0, 0.12, 1.16)
/** `Art/FirstPerson` localScale. A ~6% squash on the long axis. */
/**
 * The art transform, shared with the GHOSTS.
 *
 * Exported because `game/ghosts.ts` kept its own copy of these three, they were
 * identical, and then `SHIP_MODEL_YAW` was corrected from -90 to +90 and the
 * ghost's copy was not — so every ghost in the game flew backwards while the
 * player flew forwards. Matt caught it the same way he caught the original:
 * *"the ghosts are facing backwards it looks like."*
 *
 * One ship mesh, one art transform. If a ghost ever needs a different one, it
 * can say so at the call site rather than by forking a constant.
 */
export const ART_SCALE = new THREE.Vector3(0.98, 0.98, 0.938)

/**
 * The art's own yaw — which is +90 here for the same reason the positions above
 * have a flipped z.
 *
 * `Art/FirstPerson` is authored at **-90 degrees** about Y in the shipped
 * prefab. Our world is Unity's mirrored in z, and that flip is a conjugation
 * (`render/unity-space.ts`): it negates a quaternion's x and y, which turns a
 * Unity yaw of θ into a three yaw of **−θ**. Every position on this ship is
 * converted — the prefab's (0, 1.03, -1.27) is `EYE`'s (0, 0.86, 1.27) — and the
 * rotation was the one thing that was not.
 *
 * ── Why it was wrong in a way that LOOKED right ───────────────────────────
 *
 * It was established empirically first: four copies rendered at 90-degree steps,
 * Matt pointing out which way each faced, because the mesh is a flat wedge with
 * no nose readable from a distance and its longest extent is the beam, not the
 * length. That test picked -90, the source said -90, and the agreement was taken
 * as confirmation.
 *
 * It was a coincidence, and the coincidence was the MIRROR. Every mesh out of
 * the converter arrived mirrored in x (provenance trap 11). The cockpit is
 * exactly symmetric in z — measured, -3.083 to 3.083, against an asymmetric
 * -3.162 to 3.653 in x — so z is the beam and x is the fore-aft axis. And for a
 * mesh symmetric in z, a mirror in x IS a 180-degree yaw:
 *
 *     M_x = R_y(180) · M_z,  and  M_z · C = C,  so  M_x · C = R_y(180) · C
 *
 * The empirical test was therefore run on a ship that was already turned around,
 * and it picked the yaw that turned it back: -90 instead of +90, differing by
 * exactly the 180 the mirror had introduced. Two wrongs, one right-looking ship.
 *
 * Un-mirroring the mesh removed one of them and left the other, which is what
 * Matt saw immediately: "looks like it's flying backwards?"
 */
export const SHIP_MODEL_YAW = Math.PI / 2

/**
 * Hang one of the ship's two meshes in the frame of a parent standing at
 * `frame` (ship frame, THREE space): the art pivot, at `ART_PIVOT`, in a flight
 * (DEV-365). `loadHoverJetFlight` applies it to both meshes; exported so
 * `tests/unit/art-pivot.test.ts` measures the cockpit placed by the game's own
 * rule rather than by a copy of it.
 */
export const hangShipArt = (art: THREE.Object3D, frame: PointLike): void => {
  art.position.copy(onPivot(ART_POSITION, frame))
  art.rotation.y = SHIP_MODEL_YAW
  // `Art/FirstPerson`'s own localScale. The 100x unit correction that used to
  // be here is gone: the GLB is re-exported at the right size by
  // `tools/assets/convert-fbx.py`, so this is only the prefab's own squash.
  art.scale.copy(ART_SCALE)
}

/**
 * Where 2016 PARKS the camera rig on CHANGE VIEW, off the sheet. DEV-128.
 *
 * `CamChanger.camTargets[1]` on the shipped prefab: `shipOffset/CamRoot_3rdPerson`,
 * 8.89 m behind, 1.73 m above and pitched 10.9° down, composed to the ship root.
 * `Input_Ship.cs:312` reparents the camera rig here RIGIDLY on the X button —
 * the "CHANGE VIEW" of 2016's own controls poster — and swaps `Art/FirstPerson`
 * for `Art/ThirdPerson`.
 *
 * It is a PARKING SPACE, not the camera. The rig does not stay here: see
 * `HOVERJET_THIRD_PERSON_CHASE` below, which is where it actually flies to.
 * Kept because the parking space is real, because the toggle is what it is, and
 * because the hangar's ship-select frames the jet from it.
 */
export const HOVERJET_THIRD_PERSON: ShipCamera = shipCameraFromSheet(HOVERJET.camera.thirdPerson)

/**
 * 2016's third-person camera, the whole of it. DEV-156.
 *
 * The constraint stack on the parked root: cut loose from the ship 0.25 s in,
 * SmoothDamped toward `cam target 3rdPerson` 12.5 m back and 1.7 m up, aimed at
 * the ship, roll forced to zero. `render/classic-chase.ts` is the mechanism and
 * says why each of the four components matters.
 */
export const HOVERJET_THIRD_PERSON_CHASE: ShipChase = shipChaseFromSheet(
  HOVERJET.camera.thirdPersonChase,
)

/**
 * What the app reads off the vehicle, whichever vehicle it is.
 *
 * `app.ts` touches exactly two things through `Flight.jet` — `body` and
 * `chain` — so that is what this carries. `HoverJet` satisfies it structurally
 * and is passed through unchanged; the JumpSeat supplies its own body and an
 * INERT speed chain, because it has none (no `EnergySystem_Ship`, no
 * `maxSpeed`, no `speedChain` group in the sheet) and `app.ts` calls
 * `chainGate()` on every scored gate without knowing which ship it is flying.
 *
 * HANDOVER: the honest end state is for the chain to move behind a
 * hoverjet-only branch in `app.ts`, at which point this narrows to `body`.
 * Widening `jet` from `HoverJet` to this is deliberately the smallest change
 * that lets a second vehicle exist without touching `app.ts` at all.
 */
export interface FlightShip {
  readonly body: RigidBody
  readonly chain: SpeedChainState
  /**
   * The sheet the HoverJet was built from — 2016's, or an aircraft variant's
   * view of it (DEV-380) — so the boost tank `app.ts` steps reads THIS jet's
   * burn rates. Absent on a JumpSeat, which has no tank of that kind; hand it
   * to `energySpec` as it is and the default, 2016's, applies.
   */
  readonly sheet?: HoverJetSheet
}

/**
 * The HoverJet a flight flies, or null on a JumpSeat — whose `jet` is a body
 * and an inert chain, and carries no engine. DEV-394: the autopilot's speed
 * law holds a target speed in the jet's own thrust, so it needs the engine
 * `FlightShip` deliberately does not expose; `loadHoverJetFlight` hands the
 * whole `HoverJet` through as `jet`, and its engine is what marks it.
 */
export const hoverJetOf = (flight: Flight): HoverJet | null =>
  'currentThrust' in flight.jet ? (flight.jet as HoverJet) : null

export interface Flight {
  readonly jet: FlightShip
  /**
   * The aircraft variant this flight was built from (DEV-380): `standard`
   * unless `?variant=` (and, from DEV-382, the hangar) chose another.
   */
  readonly variant: string
  /** The cockpit instrument panel. Parented to the ship, not the camera. */
  readonly hud: Hud
  /**
   * The next-gate arrow on the glareshield (DEV-124). Parented to the ship
   * like the HUD; `app.ts` aims it every frame from `game/next-target.ts`.
   */
  readonly nextGateArrow: NextGateArrow
  /** Where this vehicle's eye sits in the ship's frame. The arrow's offset is measured from it. */
  readonly eye: THREE.Vector3
  /**
   * Where this vehicle's `art_pivot` stands at rest, ship frame — the point the
   * lean turns the art about (DEV-365). Anything hung ON the pivot is placed in
   * its frame, so its local position is its ship-frame one minus this; the e2e
   * reads it here because it cannot import this file.
   */
  readonly pivot: THREE.Vector3
  /** The end-of-run panel. Hidden until the run ends. */
  readonly results: Results
  /** The pause menu. Hidden unless paused. Owns its own gaze hit test. */
  readonly pause: Pause
  /** What the mission is. Up until the countdown starts, as in 2016. */
  readonly briefing: Briefing
  /** The cockpit lean. Visual only — it never touches the physics body. */
  readonly lean: ArtLean
  /**
   * The ship's wing-tip trails (DEV-358), one draw. `trails.object` goes at the
   * scene ROOT: its vertices are world positions, so it cannot ride `object`.
   * `app.ts` updates it once the camera is placed, because the ribbons face the
   * eye. Absent on a ship with no wings — the JumpSeat is a chair.
   */
  readonly wingTrails?: CraftWingTrails
  readonly object: THREE.Object3D
  /** Advance one FIXED sim step. Never call with a frame delta. */
  step(actions: FlightActions): void
  /**
   * Hand the flight model the terrain to collide with.
   *
   * Called once the terrain has loaded, which is after the ship exists — so
   * collision is off for the first frames rather than the ship being held back
   * until the world is ready.
   */
  setTerrain(fields: readonly HeightField[]): void
  /** True on the tick a terrain contact begins. */
  readonly struck: boolean
  /**
   * DEV-836: what the pilot's hands asked of the engine on the last tick, for
   * the exterior hull's flames. 2016's `Input_Ship.GasPressed` fires above a
   * trigger value of 0.05 and `BoostPressed` on the boost button.
   */
  readonly engineAsk?: { readonly thrusting: boolean; readonly boosting: boolean }
  /**
   * METRES from the lowest point of the hull to the surface under it — ground
   * **or water**, whichever is higher — or `Infinity` outside every field.
   *
   * G1's input (DEV-110). It costs one extra height sample per tick and it
   * reads the same `HeightField[]` `stepTerrainCollision` does, which is what
   * makes "terrain or water" true for free: `app.ts` hands the flight BOTH
   * terrains, because the ocean is a second `FacetedTerrain` and 2016 gave it a
   * `TerrainCollider` too, so the sea stops you the way a hillside does.
   *
   * A VERTICAL distance, and not a distance to the nearest geometry: a cliff
   * face 3 m off the wingtip reads as whatever is under the belly. That was
   * the honest simplification at DEV-110, and it is still the number the
   * collision hull answers; the levers no longer read it — see
   * `nearestSurface()`, of which this is the probe that needs no march.
   */
  readonly clearance: number
  /**
   * METRES to the NEAREST surface within `reachMetres` — `clearance` and six
   * lateral probes, minimum (DEV-112; `sim/surface-proximity.ts` says what each
   * is the distance OF). The levers' input since DEV-112, so a canyon wall off
   * the wingtip is as close as a ridge under the belly.
   *
   * A METHOD with the reach as its argument rather than a readout, because the
   * reach is the far end of G1's ramp and that is the EDITION's number, not the
   * flight's: `app.ts` passes `gameplay.proximity.farMetres` at the lever site
   * and the flight never learns which preset is running. Computed on demand,
   * once per tick, AFTER `step()` has resolved the collision — the reading is
   * where the ship ended the tick. `surface` holds the breakdown of the last
   * call for telemetry.
   *
   * OPTIONAL on the interface because the JumpSeat has not been given probes:
   * its `clearance` is the belly, which is this fan with a reach of 0, and
   * `app.ts` falls back to it. Six of thirteen missions fly that ship; the row
   * says so.
   */
  nearestSurface?(reachMetres: number): number
  /** The last `nearestSurface()` call, broken down. Same caveat as above. */
  readonly surface?: SurfaceProximity
  /**
   * Engines on, or a powerless body falling. DEV-144.
   *
   * `LaunchElevator.FinishLaunch()` switches a HoverJet's gravity OFF, and
   * `HoverJet.launched` is that switch modelled honestly rather than baked to
   * false. This is the handle on it, so the energy race can turn it back on —
   * *"run dry and you fall"* — without `app.ts` reaching into the sim's own
   * state, and without this module learning what a mode is.
   *
   * It takes a plain boolean for exactly that reason: `game/modes.ts` is the
   * only file allowed to spell a mode, and a vehicle should not know why its
   * engines went out.
   *
   * OPTIONAL, like `nearestSurface` above and for the same shape of reason: the
   * JumpSeat has no such switch. Its thruster latches off when its own tank
   * empties (`sim/jumpseat.ts` §3) and gravity is on for it the whole time,
   * which is a different vehicle solving the same problem its own way.
   *
   * `placeAt()` and `respawn()` both set `launched` back to true, so a restart
   * or a crash reset re-lights the engines without this being called again.
   */
  setPowered?(on: boolean): void
  /**
   * THE JUMPSEAT'S TANK, as an instrument reads it. DEV-201.
   *
   * `fraction` is `currentFuel / maxFuel` and `lit` is whether the thruster is
   * still switched on — `FuelManager.disableThisWhenEmpty`, which resolves to
   * the Thruster itself and is LATCHED off until a pad puts fuel back in
   * (`sim/jumpseat.ts` §3). The two are not the same reading: the tank goes
   * NEGATIVE, so a seat that has been digging on an empty tank is at `-0.5` and
   * dark, and five seconds of pad contact later it is still dark and climbing.
   *
   * ABSENT on the HoverJet, which has no such tank — the shape `nearestSurface`
   * and `setPowered` already use for "this vehicle does not answer that".
   *
   * It exists because **2016's JumpSeat cockpit had exactly one instrument and
   * this was it**: `JumpSeat_Photon.prefab`'s `Ship_HUD/panel_jumpSeatUI` holds
   * `text_fuel` (`Fuel :`) and `val_fuel` (`100%`) and both are the only live
   * things on that panel, while the whole of `panel_shipUI` — gates, time, speed
   * — is authored inactive and no code can switch it on, because the prefab
   * carries no `HUD_Ship` and none of the six shipped JumpSeat scenes does
   * either. `FuelManager.cs:95-97` writes the number every frame the throttle is
   * held. The port has simulated this tank since DEV-057 and never once shown it.
   */
  readonly fuel?: { readonly fraction: number; readonly lit: boolean }
  /**
   * THE GLIDER'S STALL, as an instrument reads it. DEV-399 (G1's HUD row, with
   * the rocket, which reaches the panel through `fuel` above: a tank that
   * burns while held and comes back once released is a tank).
   *
   * `margin` is `sim/glider.ts`'s `stallMarginAt`, 0..1 — 0 at the stall
   * speed, 1 at the trim speed — so the bar drains on the way to the cliff.
   * `stalling` is the wing short of full authority, which is when it inks as a
   * warning. ABSENT on the HoverJet and the JumpSeat, neither of which has a
   * wing that can let go: the `fuel` shape.
   */
  readonly stall?: { readonly margin: number; readonly stalling: boolean }
  /**
   * True while the vehicle's OWN start countdown still holds the run. DEV-343.
   *
   * The JumpSeat's is `Trigger_EnableJumpShip`: 3.5 s and four beats from the
   * moment you board, during which the seat has gravity and torque and nothing
   * else. It is stepped through them — it has to fall and settle — but the RUN
   * has not started, so `boot/app.ts` scores nothing and runs no clock until
   * this goes false. The same shape as the HoverJet's lift, whose hold is
   * `launchHoldsShip(launch)` in `boot/app.ts` and never reaches this member.
   *
   * ABSENT on the HoverJet, the shape `fuel` uses.
   */
  readonly countdownHolds?: boolean
  /**
   * Where a dry JumpSeat's stranded rule has got to. DEV-342. ABSENT on the
   * HoverJet, which has no latching thruster to strand it.
   *
   * `phase` is `sim/jumpseat-stranded.ts`'s: `stranding` while a dry seat sits
   * out of every pad's reach, `dying` once the run is lost. `restart` is true on
   * the ONE step the run should restart, as an out-of-bounds death does.
   */
  readonly stranded?: { readonly phase: StrandedPhase; readonly restart: boolean }
  /**
   * Where the JumpSeat's head-strike rule has got to. DEV-403: 2016's own
   * JumpSeat death, `Trigger_Reset` on `collider_head`. ABSENT on the HoverJet,
   * whose prefab has no `Trigger_Reset`.
   *
   * `phase` is `sim/jumpseat-head.ts`'s: `dying` from the touch until the
   * restart, with no warning phase before it (2016 had none). `restart` is true
   * on the ONE step the run should restart. Never `dying` at the same time as
   * `stranded` is: `stepJumpSeatDeaths` allows one death at a time.
   */
  readonly headStrike?: { readonly phase: HeadPhase; readonly restart: boolean }
  /**
   * The prop colliders this vehicle's OWN rules test against, or null. DEV-403.
   *
   * The JumpSeat's head strike counts a tree or a rock (Matt, 2026-09-25), so
   * `boot/app.ts` hands over the same colliders its prop collision steps
   * against, and null wherever it steps none. ABSENT on the HoverJet, whose
   * prop contact is `app.ts`'s alone.
   */
  setProps?(colliders: PropColliders | null): void
  /**
   * The jumping spider's jump (DEV-383), as the HUD and `__ff2` read it:
   * `charge` 0..1 while both triggers are held on a surface, `firing` while the
   * burst is being delivered, and the jumps fired this run. ABSENT on every
   * vehicle whose variant carries no jump, the shape `fuel` uses.
   */
  readonly jump?:
    | { readonly charge: number; readonly firing: boolean; readonly jumps: number }
    | undefined
  /**
   * The body's vertical velocity change over the last FIXED step, m/s² — the
   * sim's own tick, never differenced frame to frame (`render/vignette.ts`
   * says why). What the comfort vignette's linear term reads (DEV-383): a
   * vertical launch is a vection spike the angular rate cannot see. ABSENT on
   * the HoverJet, which flies with gravity off and is never launched upward.
   */
  readonly verticalAcceleration?: number
  /**
   * Put the ship on the elevator platform, `rise` metres above the spawn marker.
   *
   * Replaces `step()` for the duration of the launch. 2016 held the rigidbody
   * KINEMATIC and parented to the platform for the whole ride
   * (`LaunchElevator.StartLaunch`), so there is no integration to do: the
   * animation owns the position and the flight model is not running yet.
   *
   * Velocity is zeroed every tick rather than left alone, so that the first tick
   * of real flight starts from rest instead of inheriting whatever the body had
   * before the ride began.
   */
  rideElevator(rise: number): void
  /**
   * Put the ship back on the RESPAWN marker, at rest.
   *
   * 2016 reloads the scene with `PlayerPrefs["Respawning"] = "true"`, which
   * spawns at `SinglePlayerRespawnPosition` — 127.86 m on `int_01`, the top of
   * the shaft — and makes `LaunchElevator.StartLaunch()` bail. So a boundary
   * death does NOT put you back on the lift; you come back already flying.
   */
  respawn(): void
  /**
   * Put the ship at a given pose with a given velocity, at rest otherwise, and
   * collapse the interpolation onto it. The crash reset (DEV-126) — `respawn`
   * with a destination that is not the marker. SIM space in.
   */
  placeAt(position: Vec3, orientation: Quat, velocity: Vec3): void
  /**
   * METRES PER SECOND into the surface this tick, off the contact. 0 when
   * nothing was hit. The crash rule's input; see `TerrainCollisionState`.
   */
  readonly impactSpeed: number
  /** Draw between the last two sim states. `alpha` is 0..1 within the step. */
  render(alpha: number, camera: THREE.Camera, rig: THREE.Object3D | null): void
  /**
   * The Anniversary cockpit buffet — ANNIVERSARY.md S3, DEV-083.
   *
   * Moves the ART PIVOT and nothing else. The camera, the XR rig and the sim
   * body are structurally out of reach: `render()` derives the eye from `object`
   * and the body, and this writes to a node hanging off `object` that neither of
   * them reads. That is the Squadrons rule (§2.4) made a property of the object
   * graph rather than a promise in a comment.
   *
   * Idempotent and order-free with `render()`: both recompute the pivot's whole
   * pose, so calling this before, after or instead of `render()` gives the same
   * answer, and calling it twice changes nothing. Every frame gets the call —
   * Classic included — because the PRESET decides whether anything moves, not
   * the caller, and a flip must need no rewiring.
   *
   * @param shake  `edition.cockpit.shake`, passed straight through. Read live;
   *               never cached here, so a preset flip lands on the next frame.
   * @param scale  `editionState.speedFx`, the comfort slider as 0 / 0.5 / 1.
   * @param time   RENDER seconds. Visual only, like the waves and the particles.
   * @param forwardSpeed  `ForwardSpeed`, m/s — the quantity 2016 keys effects to.
   * @param active False in the hangar, while paused, and for the elevator ride.
   * @param jolt   A racer's hit on top of the buffet, in multiples of the
   *               preset's amplitude (DEV-364 follow-up, `game/racer-hit.ts`).
   *               0, or absent, is the buffet alone.
   *
   * DEV-426: a HoverJet also weighs its buffet by its own ENGINE — the spooled
   * thrust and the live chain's terminals, read off the jet here rather than
   * passed in — through `shake.throttle` (`game/cockpit-shake.ts`). The
   * JumpSeat and the glider have no such engine and keep the buffet as it was.
   */
  shake(
    shake: EditionCockpitShake,
    scale: number,
    time: number,
    forwardSpeed: number,
    active: boolean,
    jolt?: number,
  ): void
  /**
   * The Anniversary cockpit INTERIOR — ANNIVERSARY.md V8, DEV-088.
   *
   * A dim cabin fill, a glow under the readout, and a body in the seat. Like
   * `shake()` it hangs everything off the ART PIVOT and reads the preset live,
   * so a flip needs no rewiring — but unlike `shake()` nothing here changes per
   * frame, so this is called once when the ship is built and once per flip
   * rather than every frame.
   *
   * On Classic it constructs nothing, adds nothing to the scene graph, and puts
   * the cockpit material's `emissive` back to what the loader made it.
   *
   * @param cockpit `edition.cockpit`, passed straight through. Never cached.
   */
  setInterior(cockpit: EditionCockpit): void
  /**
   * DEV-640: the cabin lamps warm and brighten while boost burns, `level` 0..1,
   * already eased by the caller. Absent on a seat with no lazy cabin (the
   * JumpSeat) and on test fakes. Intensity and colour only: no program recompiles.
   */
  setBoostGlow?(level: number): void
  /**
   * Wear the cockpit (`'first'`) or the exterior hull (`'third'`).
   *
   * 2016's ship prefab carries both — `Art/FirstPerson` active,
   * `Art/ThirdPerson` at `m_IsActive: 0` — and swaps them when the camera goes
   * outside. The port needs exactly the same swap for the same reason: in the
   * hangar the ship is PARKED IN FRONT OF YOU, and a cockpit seen from outside
   * is a handful of canopy struts (see the note in `game/ghosts.ts`, which
   * spent three wrong guesses on that discovery).
   */
  setView(view: ShipView): void
  /**
   * Whether the exterior hull stays in the scene WHILE YOU ARE IN THE COCKPIT,
   * so that it can cast. `render.shipShadow.enabled`, DEV-305, wishlist #29.
   *
   * Matt: *"player ship casts shadows — use the 3rd-person model as the
   * caster."* Right, and every obvious way to do it is refused by three:
   * `object.visible`, `material.visible` and the layer test are all read by the
   * shadow pass as well as by the frame (`render/shadows.ts`'s header). So the
   * hull is DRAWN and writes no colour and no depth — a real draw with a real
   * cost, which is why this is a preset flag and not a constant.
   *
   * Idempotent and cheap, like `setView`, and it must be called with it: the
   * two decide one thing between them and `setView` runs every frame.
   */
  setShipShadow(on: boolean): void
  /**
   * Put the cockpit readout where the preset says, from THIS vehicle's eye.
   * DEV-129. Called at construction and by the lookdev Placement folder; the
   * numbers are `cockpit.placement.hud` in `content/editions/*.json` — or
   * `cockpit.placement.jumpSeatHud` on the JumpSeat (DEV-362,
   * `hudPlacementFor`). The HoverJet's also sets its panel into the dash.
   */
  placeHud(placement: EditionHudPlacement): void
  /**
   * DEV-362. The node the readout hangs on in the cockpit, when it is not the
   * ship's own group: the HoverJet's is the ART PIVOT, because its panel is set
   * into a dash that leans. Absent means `object`, which is the JumpSeat's.
   * `boot/app.ts` puts the panel back here when the chase camera lets it go.
   */
  readonly hudMount?: THREE.Object3D
  /**
   * Where 2016 PARKS the camera rig for this vehicle, ship frame, off the sheet
   * (`*.camera.thirdPerson`). A parking space, not the camera. DEV-128/DEV-156.
   */
  readonly thirdPersonCamera: ShipCamera
  /**
   * What 2016's third-person camera actually does for this vehicle, off the
   * sheet (`*.camera.thirdPersonChase`): detach, damp, aim, level the roll.
   * What the Classic toggle draws. `render/classic-chase.ts`. DEV-156.
   */
  readonly thirdPersonChase: ShipChase
  dispose(): void
}

/** Which of the ship's two meshes is showing. */
export type ShipView = 'first' | 'third'

/**
 * The ship for this mission.
 *
 * `level.vehicle` is extracted per mission (`hoverjet` on seven, `jumpseat` on
 * six) and is the only thing this branches on — no mission id, no environment,
 * no mode. Content is data (hard rule 6): a mission that wants the other vehicle
 * changes one string in its JSON.
 */
export const loadFlight = async (
  level: Level,
  hud: EditionHudPlacement,
  // DEV-256. How the readout's canvas is built. Optional and defaulted for
  // `update(state, nowMs = performance.now())`'s reason: every caller written
  // before this row, and every screenshot builder, keeps working unchanged.
  // It has to be a CONSTRUCTION argument rather than a setter because
  // `getContext` options are honoured only on a canvas's first context —
  // `render/hud.ts`'s DEV-256 block has the whole of why.
  hudOptions: HudOptions = {},
  // DEV-380. The aircraft variant, already resolved against the vehicle's own
  // file and the edition (`content/load-aircraft.ts`), so this module never
  // decides whether variants exist. Defaulted, like `hudOptions`, so every
  // caller that predates variants flies 2016.
  variant: FlightVariant = STANDARD_FLIGHT_VARIANT,
): Promise<Flight> => {
  // DEV-399: the third arm. `flightSeamFor` is the branch, as a pure function a
  // unit test can hold without loading a mesh.
  const seam = flightSeamFor(level.vehicle)
  if (seam === 'jumpseat') return loadJumpSeatFlight(level, hud, hudOptions, variant)
  if (seam === 'glider') return loadGliderFlight(level, hud, hudOptions, variant)
  return loadHoverJetFlight(level, hud, hudOptions, variant)
}

/**
 * Which seam flies `vehicle`: the ONE decision `loadFlight` makes (DEV-399).
 * Exhaustive over `VehicleId` — a fourth aircraft is a type error here until it
 * has an arm — and never a fallback: an aircraft this does not name is not
 * flown as a HoverJet, which is what the glider course did for its whole life
 * before G1 (`vehicle` said `hoverjet` and `flightModel` was read by nothing
 * that flew).
 */
export const flightSeamFor = (vehicle: Level['vehicle']): 'hoverjet' | 'jumpseat' | 'glider' => {
  switch (vehicle) {
    case 'hoverjet':
      return 'hoverjet'
    case 'jumpseat':
      return 'jumpseat'
    case 'glider':
      return 'glider'
  }
}

/**
 * The physics under the HoverJet's cockpit and hull — DEV-399.
 *
 * The HoverJet's own flight model, or the glider's, which borrows the whole of
 * the HoverJet's art, HUD, camera and hull until it has its own (G3 is Matt's
 * asset call; 2016's own `PlayerShip_Glider_Photon` IS a HoverJet prefab with
 * `maxSpeed 0` and gravity on). Everything {@link loadAirframeFlight} does to a
 * flight model goes through this, so the HoverJet is the code it always was
 * behind one indirection and the glider is a second implementation of five
 * members rather than a second copy of six hundred lines.
 */
export interface Airframe {
  /** What `Flight.jet` hands the app: the body, the chain, the sheet. */
  readonly ship: FlightShip
  /** The flight's group in the scene graph. */
  readonly name: string
  /**
   * Does the hover cushion hold it off the ground? The HoverJet's does
   * (`hoverMotor` off the prefab, 3.5 / 4); a glider has no hover motor, and
   * the ground it meets is the ground (G1's "the hover motor off").
   */
  readonly hovers: boolean
  /**
   * One FIXED tick of the flight model: the pilot's intent in, the body
   * moved. Runs BEFORE the hover motor and the ground, as `stepHoverJet`
   * always did. `clearance` is the belly reading the LAST tick ended on — the
   * glider's ground effect (`Flight.clearance` into `glider.clearance`); the
   * HoverJet does not read it.
   */
  fly(actions: FlightActions, clearance: number): void
  /**
   * Cold, as a reload leaves it: the HoverJet's engine spooled down and its
   * gravity switched off (`launched`); the glider's rocket full. Every
   * placement — spawn, respawn, crash reset — ends with it.
   */
  reset(): void
  /**
   * Set a body that has just been placed AT REST going the way this airframe
   * starts. The HoverJet starts at rest (on the lift, or at the top of the
   * shaft after a respawn), so it does nothing; the glider starts at its trim
   * speed along its nose, or it would start inside its own stall. Not called
   * by a crash reset, which carries its own velocity.
   */
  start(): void
  /** `Flight.setPowered`'s arm. Absent: the airframe has no such switch. */
  setPowered?(on: boolean): void
}

/** The HoverJet, as an {@link Airframe}: `stepHoverJet` on one jet. */
export const hoverJetAirframe = (jet: HoverJet): Airframe => {
  // This jet's own input object — never a shared one (trap 19).
  const input = noInput()
  return {
    ship: jet,
    name: 'hoverjet',
    hovers: true,
    fly(actions) {
      input.throttle = actions.throttle
      input.boost = actions.boost
      // Assigned every tick, absent included, so a partly paid boost cannot
      // linger into a tick whose actions carry none (trap 19's cousin).
      input.boostPower = actions.boostPower
      // `brake` and `airbrake` are two names for one thing in the shipped rig;
      // either shoulder bleeds speed.
      input.brake = actions.brake || actions.airbrake
      input.pitch = actions.pitch
      input.yaw = actions.yaw
      input.roll = actions.roll
      stepHoverJet(jet, input)
    },
    reset() {
      // The engine spools; a reload starts it cold rather than inheriting
      // whatever thrust you died holding — and it is launched, so its gravity
      // stays off (`LaunchElevator.FinishLaunch()`).
      jet.currentThrust = 0
      jet.launched = true
    },
    start() {
      // At rest, exactly as 2016 leaves it: on the lift, or at the top of the
      // shaft after a respawn.
    },
    setPowered(on: boolean) {
      // One assignment, and `stepHoverJet` turns it into `body.useGravity =
      // !launched` on the next tick. Writing `body.useGravity` here instead
      // would last exactly one tick before the flight model overwrote it.
      jet.launched = on
    },
  }
}

export const loadHoverJetFlight = async (
  level: Level,
  hudPlacement: EditionHudPlacement,
  hudOptions: HudOptions = {},
  variant: FlightVariant = STANDARD_FLIGHT_VARIANT,
): Promise<Flight> => {
  // DEV-380: the jet's numbers, as a VIEW of 2016's sheet. `standard`'s view is
  // the sheet itself.
  const sheet = hoverJetView(variant.scale)
  return loadAirframeFlight(
    level,
    hudPlacement,
    hudOptions,
    variant.id,
    sheet,
    hoverJetAirframe(createHoverJet(sheet)),
  )
}

/**
 * The glider, flown — DEV-399 (AIRCRAFT-VARIANTS §5, G1). `sim/glider.ts`'s
 * model under the HoverJet's art: {@link loadAirframeFlight} with the glider's
 * airframe, 2016's HoverJet hull for the ground to meet (the art IS that
 * hull), and `game/glider-flight.ts`'s seam on top — the autopilot, the rocket
 * as `Flight.fuel` and the stall margin as `Flight.stall`.
 */
export const loadGliderFlight = async (
  level: Level,
  hudPlacement: EditionHudPlacement,
  hudOptions: HudOptions = {},
  variant: FlightVariant = STANDARD_FLIGHT_VARIANT,
): Promise<Flight> => {
  const glider = gliderFor()
  const flight = await loadAirframeFlight(
    level,
    hudPlacement,
    gliderHudOptions(glider, hudOptions),
    variant.id,
    HOVERJET,
    gliderAirframe(glider),
  )
  return withGliderSeam(flight, glider)
}

/**
 * A flight in the HoverJet's cockpit and hull, flown by `airframe`.
 *
 * `hull` is the sheet the HULL is read from — the hover cushion, the collision
 * colliders and the speed gauge's full scale: the jet's own view of the sheet
 * for a HoverJet (DEV-380), and 2016's for the glider, which flies in that hull
 * as a stand-in (DEV-399).
 */
export const loadAirframeFlight = async (
  level: Level,
  hudPlacement: EditionHudPlacement,
  hudOptions: HudOptions,
  variantId: string,
  hull: HoverJetSheet,
  airframe: Airframe,
): Promise<Flight> => {
  const sheet = hull
  // BOTH meshes, as the prefab carries both. They are loaded together rather
  // than on demand because the swap happens on a screen change, and a screen
  // change that has to wait on a network fetch is a stutter you cannot hide.
  const [gltf, exterior] = await Promise.all([
    loadMesh(assetUrl(SHIP_MESH)),
    loadMesh(assetUrl(SHIP_MESH_EXTERIOR)),
  ])
  const object = new THREE.Group()
  object.name = airframe.name
  // The art pivot. The lean rotates THIS, not the camera — see the note on EYE.
  // It stands at 2016's `art_pivot`, so everything hung on it below is placed
  // in ITS frame with `onPivot` (DEV-365); `applyPivot` puts it there.
  const artPivot = new THREE.Group()
  artPivot.name = 'art_pivot'
  artPivot.position.copy(ART_PIVOT)
  // The SAME art transform on both, because the prefab authors the same one on
  // `Art/FirstPerson` and `Art/ThirdPerson` — same -89.988 degree yaw, same
  // (0.98, 0.98, 0.938) scale. Applied in a loop rather than twice, so the two
  // cannot drift the way the ghost's copy of `SHIP_MODEL_YAW` drifted.
  for (const art of [gltf.object, exterior.object]) {
    hangShipArt(art, ART_PIVOT)
    artPivot.add(art)
  }
  gltf.object.name = 'ship_first_person'
  exterior.object.name = 'ship_third_person'
  object.add(artPivot)
  // DEV-358: the wing tips, off the hull before anything else is hung on it,
  // in the ART PIVOT's frame, so the trails lean with the airframe the way the
  // wing they leave from does. `render/wing-trails.ts` says where they are.
  const wingTips = measureWingTips(exterior.object)

  // ── the hull, in first person: hidden, or drawn and contributing nothing ──
  //
  // DEV-305, wishlist #29. 2016 deactivates `Art/ThirdPerson` in the cockpit
  // and the port copied it, which is faithful and which also means the ship
  // casts no shadow on the ground you are flying over — the one shadow whose
  // LENGTH you can read against your own altitude, and §1.5's second scale cue
  // applied to the object the player is steering.
  //
  // `render/shadows.ts` says why there is no cheap way to do this: three reads
  // `object.visible`, `material.visible` and the layer mask in the SHADOW pass
  // as well as in the frame. So with the flag on the hull is drawn with
  // `colorWrite` and `depthWrite` off, which costs a draw call and the vertex
  // work and buys the shadow. With the flag off it is hidden, exactly as 2016
  // left it, and the materials are put back — so Classic and a headset get the
  // shipped behaviour and not a version of it that happens to look the same.
  //
  // It composes with DEV-246's draw order by accident and in the right
  // direction: `cockpitEligible` refuses a material with `depthWrite` false, so
  // a hull first SEEN in this state is skipped by `setCockpitFirst` rather than
  // drawn early — which is what you want from a mesh that writes nothing. This
  // first call runs with the flag off, so the hull is memoised opaque and keeps
  // whatever order it had; the state below only ever moves afterwards.
  let shipView: ShipView = 'first'
  let shipShadow = false
  const applyHullVisibility = (): void => {
    const drawnForShadow = shipView === 'first' && shipShadow
    // The cockpit is what you boot into, and it is what `m_IsActive` says.
    exterior.object.visible = shipView === 'third' || drawnForShadow
    setColourlessDraw(exterior.object, drawnForShadow)
  }
  applyHullVisibility()

  // ── the material the glTF could not carry ──────────────────────────────
  //
  // BOTH presets, because this is a bug and not a taste: the GLBs declare
  // Maya's `lambert1` (0.5 grey, the default shader an FBX is born with) where
  // the game renders Unity's (`_Color` 0.822 sRGB), so the whole ship was 1.28
  // to 1.42x too dark and had lost its cool cast. DEV-043 found and fixed the
  // same thing on the title logo and wrote the rule down; the ship was never
  // done. `render/lambert1.ts` has the `.mat` and the provenance. DEV-088.
  applyLambert1(gltf.object)
  applyLambert1(exterior.object)

  // ── the part the glTF does not contain at all (DEV-310 → DEV-322) ──────
  //
  // 2016's third-person hull is THREE live renderers and the exterior GLB is
  // one of them. The other two are the anti-grav wing — six upturned
  // projectors and ten glowing pieces, `Mesh1-Combined` and `Mesh2-Combined`
  // under `anti-grav_rightWing` — and since DEV-322 they are 2016's own art,
  // ported into the hull GLB's frame. `render/hover-glow.ts` has the argument.
  //
  // On the EXTERIOR art, so `setView` hides it with the hull: this is the C
  // key's art in 2016 and it is not visible from the seat. The player's
  // projectors wear `Projector04_Mat`, as the player prefab has them.
  const glow = await attachShipWings(exterior.object)

  // ── the cabin: light, and a body in the seat (Anniversary) ─────────────
  //
  // On the ART PIVOT, at the EYE. The pivot because 2016 hangs the pilot and
  // the chair off `art_pivot` too, so the cabin leans and buffets around a
  // still head exactly as the cockpit does; the eye because that is the frame
  // research 05 §3.1 measured the seat in and the frame the preset is written
  // in. Constructs nothing until a preset asks — see `setInterior`.
  // The eye in the pivot's frame (DEV-365). The eye is not ON the pivot — the
  // camera never is — but the cabin and the readout are placed from it.
  const eyeOnPivot = onPivot(EYE, ART_PIVOT)
  const interior = createCockpitInterior(gltf.object)
  interior.object.position.copy(eyeOnPivot)
  artPivot.add(interior.object)

  // The instrument panel, SET INTO THE DASH — DEV-362, Matt with two 2016
  // screenshots: *"see how they're recessed into the 'dashboard'?"*
  //
  // The mesh has the recess: a near-black glass face under a brown hood,
  // between two side walls, above a brown sill, dead ahead where the canopy
  // struts meet the dash. 2016's `Ship_HUD` canvas puts its upper screen
  // 14-36 mm proud of that glass and its speed strip on the sill, and the
  // preset's `cockpit.placement.hud` is now that pose (`render/hud-dash.ts`
  // has the composition, `tests/unit/hud-recess.test.ts` measures it against
  // the mesh). This comment used to place the panel on "the dark console
  // face" at z 0.94 — 46 dark vertices that are the console's back, between
  // the pilot's knees, not the screen — and turn it square to the eye in
  // front of the dash nose, which is the floating plate Matt called
  // disjointed.
  //
  // On the ART PIVOT, as 2016's is (`art_pivot/Art/FirstPerson/
  // FirstPersonHUDRoot`). It used to hang on the ship so that it would not
  // lean with the airframe; set into the dash that is the wrong way round: the
  // lean (5.25 degrees of roll, 4.8 of pitch, about `art_pivot` — DEV-365)
  // moves the recess by up to 7.8 cm, and a screen that stayed put would slide
  // out of its bezel and through the hood. It leans with the dash it is set in,
  // and the eye — which the pivot does not carry — reads it as an instrument.
  // Still never on the camera rig: a head-locked HUD is the most reliable way
  // to make someone ill in VR.
  //
  // `placeHudAt` is the one rule both vehicles apply (DEV-129's numbers, from
  // this vehicle's eye). The JumpSeat reads `cockpit.placement.jumpSeatHud`,
  // so this does not move it (the lead's condition, and a test holds it). The
  // eye it is handed is the eye in the PIVOT's frame, because that is the frame
  // the panel hangs in (DEV-365): the preset's offset is still from the eye.
  // The gauge's full scale follows the jet (DEV-380): a speed variant's chained
  // boosted terminal would peg 2016's needle. `speedGaugeFullScale(HOVERJET)` is
  // `HUD_GAUGE_SPEED_FULL_SCALE` to the bit, which a unit test holds, so
  // `standard`'s panel is the one it always was. An explicit caller value wins.
  const hud = createHud({ speedFullScale: speedGaugeFullScale(sheet), ...hudOptions })
  const placeHud = (p: EditionHudPlacement): void => {
    placeHudAt(hud.object, p, eyeOnPivot)
    hud.setMount('dash')
  }
  placeHud(hudPlacement)
  artPivot.add(hud.object)

  // ── the next-gate arrow (DEV-124) ────────────────────────────────────
  //
  // Same group and same argument as the HUD: an instrument on the dash, not on
  // the head. Its position is the preset's offset from the EYE, applied in
  // `update` so a hand-edit of the JSON moves it without a reload. Hidden until
  // `app.ts` gives it a target.
  const nextGateArrow = createNextGateArrow()
  object.add(nextGateArrow.object)

  // ── the results panel ────────────────────────────────────────────────
  //
  // At EYE LEVEL and a little further out, where the HUD is inset into the
  // console below it. The two are read in different situations: the HUD during
  // a turn, this one at a stop — so this one is allowed to be where you are
  // already looking.
  //
  // On the SHIP's group, not the rig, so it banks with the cockpit. A panel
  // that stays world-upright while the ship rolls reads as a browser dialog
  // pasted over a game, and in a headset it is worse than that.
  const results = createResults()
  // DEV-894: a phone's panel is larger and stands left of centre (`phone-floor.ts`).
  results.object.position.set(phoneUi.on ? RESULTS_PHONE_SHIFT_M : 0, EYE.y + 0.02, EYE.z - 0.95)
  object.add(results.object)

  // ── the pause menu ───────────────────────────────────────────────────
  //
  // Slightly nearer than the results panel, because you AIM at this one: the
  // rows subtend more angle the closer they are, and a menu you steer with your
  // head wants big targets. Same group, for the same reason — it banks with the
  // cockpit, and it is over the results panel because you can pause after a run
  // as well as during one.
  // ── the mission briefing ─────────────────────────────────────────────
  //
  // ABOVE eye level, which is the one band nothing else uses: the HUD is inset
  // into the console below, the results panel is at the eye, the pause menu
  // hangs under it. It is only up before the countdown, but "only up sometimes"
  // is not a reason to let two panels share a space.
  const briefing = createBriefing()
  briefing.object.position.set(0, EYE.y + 0.2, EYE.z - 1.05)
  briefing.object.rotation.x = 0.12
  object.add(briefing.object)

  const pause = createPause()
  // BELOW eye level, and that is load-bearing rather than taste. The menu is
  // aimed with the gaze, and the gaze on a flat screen is the ship's forward —
  // which, with the sim frozen, cannot move. If a row sat where the nose
  // happens to point, it would be selected every frame and the stick could
  // never move off it. Hung here, a ray along the eye line lands in the title
  // band, so the default selection is nothing and the stick owns the choice
  // until you deliberately look down. The first row starts about 6 degrees
  // below the eye line; 2016 put its panel below the eye too.
  const pauseAt = pausePlateOffset()
  pause.object.position.set(0, EYE.y + pauseAt[1], EYE.z + pauseAt[2])
  object.add(pause.object)

  // The flight model's body. `jet` keeps its name: on a HoverJet it IS the
  // jet, and on the glider it is the glider's body wearing the jet's hull.
  const jet = airframe.ship

  // DEV-358: the ship's own wing-tip trails, one craft and one draw. Its tips
  // were measured above; the art pivot carries them, and the body's forward
  // speed decides how much vapour it makes.
  // Tinted toward the player's own orange (DEV-358 follow-up): the livery
  // panel off the FBX, the colour DEV-350 turned for every racer.
  const wingTrails = createCraftWingTrails(
    [{ tips: wingTips, frame: artPivot, body: jet.body, livery: LIVERY_PANEL_SRGB }],
    'wing-trails:player',
  )

  // ── the ground ─────────────────────────────────────────────────────────
  //
  // The hull is the ship's five SOLID colliders reduced to one sphere each —
  // two capsules and three boxes on the shipped prefab, all `isTrigger: false`.
  // See `sim/terrain-collision.ts` and DEV-020.
  const hover = createHoverMotor()
  // `hoverForce` 3.5 and `hoverHeight` 4 come off the PREFAB. The C#
  // initialisers say 65 and 3.5 — and the C#'s height is the same number as the
  // prefab's force, so a misread lands somewhere plausible and 18x too strong.
  const HOVER: HoverMotorSpec = {
    hoverForce: sheet.hoverMotor.hoverForce,
    hoverHeight: sheet.hoverMotor.hoverHeight,
  }
  const collision = createTerrainCollision()
  const baseAngularDrag = jet.body.angularDrag
  const COLLISION: TerrainCollisionSpec = {
    hull: hullFromColliders(
      sheet.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
    ),
    // Unity's built-in default material, zero bounciness, and `Flash()`'s 0.3 s
    // and x3 angular drag: see `SHIP_GROUND_CONTACT`.
    ...SHIP_GROUND_CONTACT,
  }
  let terrainFields: readonly HeightField[] = []
  let struck = false
  const engineAsk = { thrusting: false, boosting: false }
  /** The belly reading, refreshed once per sim step. See `Flight.clearance`. */
  let clearance = Number.POSITIVE_INFINITY
  /**
   * The nearest-surface breakdown, PER FLIGHT rather than module-level so a
   * second ship cannot inherit the first's readings (trap 19). Written by
   * `nearestSurface()`. See `Flight.nearestSurface`.
   */
  const surface = createSurfaceProximity()

  // `Rotator_Input` off the sheet. Visual only: it rotates `art_pivot`, which
  // the camera does not inherit, so the cockpit moves around the pilot rather
  // than moving the pilot (DEV-010).
  const rotator = HOVERJET.artRotator
  const lean = createArtLean({
    rollMax: rotator.rollMax,
    pitchMax: rotator.pitchMax,
    speed: rotator.speed,
    inputTime: rotator.inputTime,
    resetTime: rotator.resetTime,
    inputCurve: rotator.inputCurve,
    transitionCurve: rotator.transitionCurve,
    // Derived from the sheet, never typed. `Rotator_Input`'s pitch RESET is
    // inside `if (shipInput != null)` and this one's is
    // non-null — see `ArtLeanTuning.resetPitch`.
    resetPitch: rotator.shipInput.ref !== null,
  })

  // Spawn. The level JSON is THREE space; the sim is UNITY space, because the
  // flight model thrusts along body +Z and every tuning constant was measured
  // against that. Seeding the body with an unconverted three-space quaternion
  // gives a ship that flies perfectly well backwards down the course — which is
  // exactly what happened the first time. See `render/unity-space.ts`.
  threeTupleToUnity(jet.body.position, level.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, level.spawn.quat as number[])

  // ── The elevator ───────────────────────────────────────────────────────
  //
  // The spawn marker is at the BOTTOM of the shaft — 19.79 m on `int_01`, about
  // 95 m UNDER the ocean and deep inside the 164 m fog plane, where horizontal
  // visibility is under 2% at a kilometre. Spawning there and calling the ship
  // launched read as broken fog. Twice.
  //
  // `spawn.launch` now carries the real motion: `elevator_up.anim`, six Hermite
  // keys over 15.47 s rising 106.647 m. The ride is stepped in the sim
  // (`sim/launch.ts`) and this is where its output reaches the body.
  //
  // The base Y is kept so the elevator can be replayed from the bottom; the ship
  // sits at `spawnY + launch.rise` for the whole ride and the whole flight.
  const launchBaseY = jet.body.position.y
  jet.body.position.y = launchBaseY + (level.spawn.launch?.rise ?? 0)
  // Cold and launched — the HoverJet's `jet.launched = true` — and then moving
  // the way this airframe starts: the jet at rest, the glider at its trim speed
  // along the nose the spawn marker points (DEV-399).
  airframe.reset()
  airframe.start()

  const previous = {
    position: { x: jet.body.position.x, y: jet.body.position.y, z: jet.body.position.z },
    orientation: {
      x: jet.body.orientation.x,
      y: jet.body.orientation.y,
      z: jet.body.orientation.z,
      w: jet.body.orientation.w,
    },
  }
  const current = {
    position: { ...previous.position },
    orientation: { ...previous.orientation },
  }

  const lerpPos = new THREE.Vector3()
  const slerpQuat = new THREE.Quaternion()
  const a = new THREE.Quaternion()
  const b = new THREE.Quaternion()
  const eyeWorld = new THREE.Vector3()

  // ── the art pivot's pose, in ONE place ─────────────────────────────────
  //
  // Two things ride this node and they arrive from different clocks: the lean
  // on the fixed step (DEV-011) and the Anniversary buffet on render time
  // (DEV-083). Composing them at two call sites would mean one of them writing
  // `rotation.set(...)` over the other depending on frame order — so instead
  // both callers recompute the WHOLE pose from the two sources, which makes the
  // order irrelevant and a double call harmless.
  //
  // This buffet's sample belongs to THIS ship. Not a module-level scratch:
  // trap 19 is an AI racer flying on another racer's stick because exactly one
  // of those was shared between instances.
  const buffet = createShakeSample()
  // DEV-426: the engine the buffet's throttle curve reads, and this ship's own
  // scratch for it. The HoverJet's; none on the glider (DEV-399), which has no
  // spool and no chain, so it keeps the buffet as it was.
  const shakeJet = 'currentThrust' in jet ? (jet as HoverJet) : null
  const shakeEngine = createShakeEngine()

  /**
   * Both interpolation endpoints onto the body's pose, so the next frame draws
   * the ship where it IS rather than a streak from where it was. Every
   * teleport — the respawn marker, the crash reset — ends with this.
   */
  const collapseInterpolation = (): void => {
    for (const pose of [previous, current]) {
      pose.position.x = jet.body.position.x
      pose.position.y = jet.body.position.y
      pose.position.z = jet.body.position.z
      pose.orientation.x = jet.body.orientation.x
      pose.orientation.y = jet.body.orientation.y
      pose.orientation.z = jet.body.orientation.z
      pose.orientation.w = jet.body.orientation.w
    }
  }

  const applyPivot = (): void => {
    // The lean, in UNITY degrees, and the buffet on top of it, about 2016's
    // `art_pivot` — `game/art-pivot.ts` has the conversion and the Euler order.
    // This comment used to say the pivot "sits at the origin and is free",
    // because `ART_POSITION` carried the prefab's offset on the art: right for
    // where the art IS, wrong for what it turns about (DEV-365).
    poseArtPivot(artPivot, ART_PIVOT, lean.currentPitch, lean.currentRoll, buffet)
  }

  // ── DEV-246: the cockpit is drawn BEFORE the world it is flying over ───
  //
  // Here, and not in `boot/app.ts`, for DEV-241 §3's reason: the default IS
  // the switch thrown at construction, so `__ff2.drawOrderSwitch('cockpit',
  // false)` hands back what this constructor made rather than a second
  // opinion about what it made. `render/draw-order.ts` carries the argument,
  // the four-clause eligibility test and the measured ceiling.
  //
  // Called again from `setInterior` below, because the cabin is LAZY.
  setCockpitFirst(object, true)

  return {
    jet,
    variant: variantId,
    lean,
    wingTrails,
    hud,
    nextGateArrow,
    eye: EYE,
    pivot: ART_PIVOT,
    results,
    pause,
    briefing,
    object,

    placeAt(position, orientation, velocity) {
      jet.body.position.x = position.x
      jet.body.position.y = position.y
      jet.body.position.z = position.z
      jet.body.orientation.x = orientation.x
      jet.body.orientation.y = orientation.y
      jet.body.orientation.z = orientation.z
      jet.body.orientation.w = orientation.w
      jet.body.velocity.x = velocity.x
      jet.body.velocity.y = velocity.y
      jet.body.velocity.z = velocity.z
      jet.body.angularVelocity.x = 0
      jet.body.angularVelocity.y = 0
      jet.body.angularVelocity.z = 0
      // Cold engine, as a reload leaves it — the crash is an arcade reload.
      // (The glider's rocket full, which is the same idea.) No `start()`: the
      // reset carries its own velocity.
      airframe.reset()
      // And no lingering `Flash()` penalty or "already touching" flag from the
      // wreck: the contact state is rebuilt, the same as a fresh scene's.
      Object.assign(collision, createTerrainCollision())
      jet.body.angularDrag = baseAngularDrag
      struck = false
      collapseInterpolation()
    },

    get impactSpeed() {
      return collision.impactSpeed
    },

    respawn() {
      // The marker, converted the same way the spawn is: the level JSON is
      // three space and the sim is Unity space.
      threeTupleToUnity(jet.body.position, level.respawn.pos as number[])
      threeQuatTupleToUnity(jet.body.orientation, level.respawn.quat as number[])
      jet.body.velocity.x = 0
      jet.body.velocity.y = 0
      jet.body.velocity.z = 0
      jet.body.angularVelocity.x = 0
      jet.body.angularVelocity.y = 0
      jet.body.angularVelocity.z = 0
      // The engine spools; a reload starts it cold rather than inheriting
      // whatever thrust you died holding. Then moving as this airframe starts:
      // at rest for the jet, at trim speed for the glider (DEV-399).
      airframe.reset()
      airframe.start()

      // Collapse the interpolation, or the first frame draws a streak from
      // wherever you died to wherever you came back.
      previous.position.x = jet.body.position.x
      previous.position.y = jet.body.position.y
      previous.position.z = jet.body.position.z
      previous.orientation.x = jet.body.orientation.x
      previous.orientation.y = jet.body.orientation.y
      previous.orientation.z = jet.body.orientation.z
      previous.orientation.w = jet.body.orientation.w
      current.position.x = jet.body.position.x
      current.position.y = jet.body.position.y
      current.position.z = jet.body.position.z
      current.orientation.x = jet.body.orientation.x
      current.orientation.y = jet.body.orientation.y
      current.orientation.z = jet.body.orientation.z
      current.orientation.w = jet.body.orientation.w
    },

    rideElevator(rise: number) {
      // The platform owns the ship. Position comes straight from the clip; the
      // body is not integrated at all, which is what `isKinematic = true` meant.
      previous.position.x = current.position.x
      previous.position.y = current.position.y
      previous.position.z = current.position.z
      previous.orientation.x = current.orientation.x
      previous.orientation.y = current.orientation.y
      previous.orientation.z = current.orientation.z
      previous.orientation.w = current.orientation.w

      jet.body.position.y = launchBaseY + rise
      jet.body.velocity.x = 0
      jet.body.velocity.y = 0
      jet.body.velocity.z = 0
      jet.body.angularVelocity.x = 0
      jet.body.angularVelocity.y = 0
      jet.body.angularVelocity.z = 0

      current.position.x = jet.body.position.x
      current.position.y = jet.body.position.y
      current.position.z = jet.body.position.z
      current.orientation.x = jet.body.orientation.x
      current.orientation.y = jet.body.orientation.y
      current.orientation.z = jet.body.orientation.z
      current.orientation.w = jet.body.orientation.w
    },

    setTerrain(fields: readonly HeightField[]) {
      terrainFields = fields
    },

    get clearance() {
      return clearance
    },
    nearestSurface(reachMetres: number) {
      // The SAME hull and the SAME fields `stepTerrainCollision` walks — the
      // argument `hullClearance` makes for living beside the collision holds
      // here too: two ideas of how far the ground is would eventually
      // disagree, and the one that scores would be the one nobody checked.
      return probeSurface(jet.body, terrainFields, COLLISION.hull, reachMetres, surface).nearest
    },
    get surface() {
      return surface
    },
    setPowered(on: boolean) {
      // The airframe's switch — the HoverJet's `launched` (`hoverJetAirframe`
      // says why it is that and not `body.useGravity`). The glider has none.
      airframe.setPowered?.(on)
    },
    get struck() {
      return struck
    },
    engineAsk,

    step(actions: FlightActions) {
      previous.position.x = current.position.x
      previous.position.y = current.position.y
      previous.position.z = current.position.z
      previous.orientation.x = current.orientation.x
      previous.orientation.y = current.orientation.y
      previous.orientation.z = current.orientation.z
      previous.orientation.w = current.orientation.w

      // The flight model: `stepHoverJet`, or the glider's `stepGlider` with the
      // clearance the last tick ended on as its ground effect (DEV-399).
      airframe.fly(actions, clearance)
      engineAsk.thrusting = actions.throttle > 0.05
      engineAsk.boosting = actions.boost && (actions.boostPower ?? 1) > 0
      // The HOVER motor, BEFORE collision: its whole job is to stop the ship
      // reaching the ground, so it has to act before the thing that resolves
      // having reached it. Off for an airframe with none — the glider.
      if (airframe.hovers) stepHoverMotor(hover, jet.body, terrainFields, HOVER)
      // The ground. AFTER the flight model has moved the body, because this
      // resolves a penetration that only exists once it has.
      struck = stepTerrainCollision(collision, jet.body, terrainFields, COLLISION, FIXED_DT)
      // AFTER the collision has resolved, so the number a scoring lever reads is
      // the clearance the ship actually ended the tick with rather than the one
      // it had on the way into a hillside (DEV-110).
      clearance = hullClearance(jet.body, terrainFields, COLLISION)
      // `Flash()`: a contact triples angular drag for 0.3 s, so a scrape costs
      // you the ability to turn out of it.
      jet.body.angularDrag = collisionAngularDrag(collision, COLLISION, baseAngularDrag)
      // Same axes, same step. The lean reads the pilot's raw input, not the
      // ship's resulting attitude — leaning into what you ASK for is what makes
      // it read as the airframe responding to you.
      stepArtLean(lean, actions.roll, actions.pitch, FIXED_DT)

      current.position.x = jet.body.position.x
      current.position.y = jet.body.position.y
      current.position.z = jet.body.position.z
      current.orientation.x = jet.body.orientation.x
      current.orientation.y = jet.body.orientation.y
      current.orientation.z = jet.body.orientation.z
      current.orientation.w = jet.body.orientation.w
    },

    render(alpha: number, camera: THREE.Camera, rig: THREE.Object3D | null) {
      lerpPos.set(previous.position.x, previous.position.y, previous.position.z)
      lerpPos.lerp(_tmp.set(current.position.x, current.position.y, current.position.z), alpha)
      a.set(
        previous.orientation.x,
        previous.orientation.y,
        previous.orientation.z,
        previous.orientation.w,
      )
      b.set(
        current.orientation.x,
        current.orientation.y,
        current.orientation.z,
        current.orientation.w,
      )
      slerpQuat.copy(a).slerp(b, alpha)

      // Unity space -> three space, on the way out. Position flips z;
      // orientation negates x and y.
      applyUnityPose(object, lerpPos, slerpQuat)
      applyPivot()

      object.updateMatrixWorld(true)

      // The eye rides in the cockpit. In an XR session the headset owns the
      // camera's local pose, so the RIG is what gets moved — moving the camera
      // instead fights the runtime and produces exactly the mismatch between
      // head motion and view that makes people ill.
      eyeWorld.copy(EYE).applyQuaternion(object.quaternion).add(object.position)
      if (rig) {
        rig.position.copy(eyeWorld)
        rig.quaternion.copy(object.quaternion)
        // The camera is a CHILD of the rig, so its transform is LOCAL. In an XR
        // session the runtime overwrites it from the headset every frame; out
        // of session nothing does, and whatever it held last persists. A
        // spectator-orbit frame during loading left a 3 km offset in it once,
        // which put the cockpit camera three kilometres from the cockpit while
        // the rig sat perfectly on the ship.
        camera.position.set(0, 0, 0)
        camera.quaternion.identity()
      } else {
        camera.position.copy(eyeWorld)
        camera.quaternion.copy(object.quaternion)
      }
    },

    shake(shake, scale, time, forwardSpeed, active, jolt = 0) {
      // DEV-426: Matt's throttle curve, off this jet's engine. 1 on the glider
      // and wherever the preset carries no curve (Classic).
      const engineGain =
        shakeJet && shake.throttle
          ? throttleShakeGain(shake.throttle, readShakeEngine(shakeJet, shakeEngine), forwardSpeed)
          : 1
      sampleCockpitShake(buffet, shake, scale, time, forwardSpeed, active, jolt, engineGain)
      applyPivot()
    },

    setInterior(cockpit) {
      interior.set(cockpit)
      // DEV-246, and this is the call that is not optional. The cabin, the
      // pilot and the control stick are built the first time a preset asks
      // for them (`render/cockpit-interior.ts` constructs nothing until
      // then), so they are born AFTER the constructor threw the switch and
      // they arrive at three's default — which is exactly the twenty-one
      // late draws this row is about. Idempotent, so a flip that adds
      // nothing pays nothing.
      //
      // It re-asserts the DEFAULT rather than the live intent, which means an
      // A/B arm left OFF goes back on across an edition flip. Deliberate, and
      // the same trade DEV-241 took for a course swap: `xr-vrto3d-trace.spec
      // .ts` re-asserts every order arm on every poll for precisely that.
      setCockpitFirst(object, true)
    },

    setBoostGlow(level) {
      interior.setBoostGlow(level)
    },

    setShipShadow(on) {
      shipShadow = on
      applyHullVisibility()
    },

    setView(view) {
      shipView = view
      gltf.object.visible = view === 'first'
      applyHullVisibility()
      // The cabin goes with the cockpit, not with the hull. 2016 parents the
      // pilot and the chair under `Art/FirstPerson`, which is the node it
      // deactivates when the camera goes outside — and in the hangar the ship
      // is PARKED IN FRONT OF YOU, so a seat and a pair of boots hanging in a
      // hull you are looking at from three metres away is worse than nothing.
      //
      // `setShown`, and NOT the node's own visibility flag (DEV-186): the
      // cabin's two lamps hang under that node, three skips an invisible
      // subtree entirely, and dropping the scene's point-light count from 2 to
      // 0 recompiled **fifteen programs** on the first press of V. The lamps
      // stay and go to zero intensity instead; `render/cockpit-interior.ts`
      // carries the argument, and `tests/e2e/view-toggle-compile.spec.ts`
      // holds it.
      interior.setShown(view === 'first')
    },

    placeHud,
    hudMount: artPivot,
    thirdPersonCamera: HOVERJET_THIRD_PERSON,
    thirdPersonChase: HOVERJET_THIRD_PERSON_CHASE,

    dispose() {
      hud.dispose()
      nextGateArrow.dispose()
      results.dispose()
      pause.dispose()
      briefing.dispose()
      interior.dispose()
      glow.dispose()
      wingTrails.dispose()
      gltf.dispose()
      exterior.dispose()
    },
  }
}

/** Volatile scratch. Valid only inside one synchronous call — never stored. */
const _tmp = new THREE.Vector3()
