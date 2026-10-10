// src/game/jumpseat-flight.ts — the JumpSeat, flown.
//
// The `game/flight.ts` seam for the six `*_jumpSeat` missions. The flight model
// is `src/sim/jumpseat.ts` and is not touched here; this gives it input, reads
// its pose, and puts a camera on the seat.
//
// Everything structural about the JumpSeat that differs from the HoverJet is
// documented in the sim module's header. The three that show up in THIS file:
//
//  1. **It does not ride the elevator.** `rideElevator()` is a deliberate no-op.
//     `LaunchElevator.StartLaunch()` has three call sites, all in
//     `Input_Ship*.cs`, and this prefab carries no `Input_Ship`. Two of the six
//     level JSONs still say `spawn.launchKind: "elevator"` and carry a whole
//     `spawn.launch` block — extracted from a scene-baked, disconnected copy of
//     the HOVERJET's shaft rig that sits 2.7 km from where the JumpSeat spawns
//     on `int_01`. A fix to `tools/extract/level.mjs` is in flight; the no-op
//     means this file is correct either way, which is the point.
//  2. **It spawns at the marker `markerUsedAtLoad` names**, which is `"respawn"`
//     in all six. `Level.respawning` is serialised `1` in all six scenes and
//     `Level.cs:287-294` branches on it. `spawn.pos` is the wrong place: 109 m
//     below the respawn marker on `rookie_02` (the lift deck of the same shaft)
//     and 2 780.9 m away in 3-D on `int_01` (a different rig entirely).
//  3. **The countdown replaces the ride.** `Trigger_EnableJumpShip`, 3.5 s +
//     four one-second beats = T+7.5 s, and until then there is no thrust and no
//     hover — only gravity and torque. The seat FALLS from scene load.
//
// ── The tank had no way of being filled ───────────────────────────────────
//
// `sim/jumpseat.ts` ships `addFuel()` and `level.pads[].refuel` ships a 19.7 m
// sphere at 10 units/s, and until this file called one with the other **nothing
// in `src/` refuelled anything**. The JumpSeat burns 1.9 units/s from a 100-unit
// tank, so every mission ran dry at 52.6 s of throttle-on time, latched the
// Thruster off (`disableThisWhenEmpty` IS the Thruster) and fell out of the sky
// with gravity on. Invisible for as long as nobody flew one: the six JumpSeat
// missions were flying a HoverJet until DEV-048, and what found it was
// `sim/jumpseat-autopilot.ts` trying to complete a route.
//
// It lives here rather than in `game/mission.ts` because refuelling is not
// scoring — it is a property of the vehicle meeting the level, exactly like the
// terrain collision two lines below it — and because this seam already holds the
// level and the seat.
//
// ── The art is 2016's own ─────────────────────────────────────────────────
//
// `game/jumpseat-art.ts` (DEV-114). For six sessions this file drew a stand-in
// of boxes off the colliders because a note said the meshes were
// licence-blocked; DEV-111 found the note wrong — the two MATERIALS were the
// blocked things — and the meshes now ship: `jumpseat_rough_01` (seat, console,
// bottom plate, side boxes), `jumpseat_shell_04` (the orange shell), 2016's
// `hexTile` prisms, two per leg, and the three hover-engine discs and the cones
// round them (DEV-433), all placed by `JUMPSEAT.art` out of the sheet. Each leg
// turns about 2016's own hinge by the angle the SIM holds, and
// `tests/unit/jumpseat-flight.test.ts` measures where the feet land against the
// sim's. The 3.00 m beam and the asymmetric −1.48 / +1.56 wheelbase are the
// same numbers they were.

import * as THREE from 'three'
import {
  type FlightVariant,
  STANDARD_FLIGHT_VARIANT,
  validateJump,
} from '@/content/aircraft-schema'
import type { EditionHudPlacement } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { onPivot, poseArtPivot } from '@/game/art-pivot'
import { createShakeSample, sampleCockpitShake } from '@/game/cockpit-shake'
import { rulesFor, runningMode } from '@/game/modes'
import { finishPadAirspace, livePads, padZones } from '@/game/targets'
import { JUMPSEAT } from '@/generated/constants.generated'
import type { FlightActions } from '@/input/actions'
import { createBriefing } from '@/render/briefing'
import { setCockpitFirst } from '@/render/draw-order'
import { createHud, type HudOptions } from '@/render/hud'
import { HUD_LAYOUT_JUMPSEAT } from '@/render/hud-fuel'
import { createNextGateArrow } from '@/render/next-gate-arrow'
import { createPause, pausePlateOffset } from '@/render/pause'
import { createResults } from '@/render/results'
import { applyUnityPose, threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { createArtLean, stepArtLean } from '@/sim/art-lean'
import { FIXED_DT } from '@/sim/constants'
import type { CraftColliderInput } from '@/sim/craft-contact'
import {
  createJumpSeat,
  createJumpSeatStart,
  type JumpSeat,
  type JumpSeatInput,
  type JumpSeatMechanics,
  type JumpSeatStartSpec,
  jumpSeatView,
  noJumpSeatInput,
  resetJumpSeatFootProbes,
  stepJumpSeat,
  stepJumpSeatStart,
  updateJumpSeatFootProbes,
} from '@/sim/jumpseat'
import {
  createJumpSeatPilot,
  type JumpSeatPilot,
  type JumpSeatWaypoint,
  planJumpSeatRoute,
  resetJumpSeatPilot,
  routeLength,
  stepJumpSeatPilot,
} from '@/sim/jumpseat-autopilot'
import {
  createHead,
  type HeadBox,
  type HeadPhase,
  type HeadSpec,
  headBox,
  headTouches,
  resetHead,
  stepJumpSeatDeaths,
} from '@/sim/jumpseat-head'
import { resetJump } from '@/sim/jumpseat-jump'
import { resetJumpSeatLegs } from '@/sim/jumpseat-legs'
import { createRefuel, type RefuelSphere, stepJumpSeatRefuel } from '@/sim/jumpseat-refuel'
import {
  createStranded,
  resetStranded,
  type StrandedPhase,
  type StrandedSpec,
} from '@/sim/jumpseat-stranded'
import { v3 } from '@/sim/math/vec3'
import { buildPadField } from '@/sim/pad-surface'
import type { PropColliders } from '@/sim/props/collision'
import { createSpeedChain } from '@/sim/speed-chain'
import type { ContactProbe, TargetZone } from '@/sim/targets'
import type { HeightField } from '@/sim/terrain/height-field'
import {
  collisionAngularDrag,
  createTerrainCollision,
  hullClearance,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'
import { SHIP_GROUND_CONTACT } from './cockpit-common'
import type { Flight, ShipView } from './flight'
import { JUMPSEAT_ART_PIVOT, type JumpSeatArt, loadJumpSeatArt } from './jumpseat-art'
import {
  type ShipCamera,
  type ShipChase,
  shipCameraFromSheet,
  shipChaseFromSheet,
} from './ship-camera'

// The leg specs moved to the art module with the art; re-exported so nothing
// that imported them from here has moved.
export { JUMPSEAT_LEG_SPECS } from './jumpseat-art'

/**
 * `Trigger_EnableJumpShip`'s timing.
 *
 * `triggerDelay: 3.5` is on the shipped `playerstart_jumpSeat.prefab:20136` and
 * the 4-count is a call-site literal at `Trigger_EnableJumpShip.cs:37`.
 *
 * TODO(extract): this belongs in the level JSON, not here — content is data
 * (hard rule 6). `tools/extract/level.mjs` should emit
 * `spawn.enableJumpSeatDelay` (3.5) and `spawn.enableJumpSeatCount` (4) off the
 * `Trigger_EnableJumpShip` on the spawn rig, replacing the bogus `spawn.launch`
 * block for JumpSeat missions (spec W-1). The read below already prefers the
 * JSON and only falls back to these, so the day those fields land this constant
 * stops being consulted without another edit here.
 */
const SHIPPED_START: JumpSeatStartSpec = { triggerDelaySeconds: 3.5, countdownSeconds: 4 }

/**
 * 2016's JumpSeat death: the pilot's head touches anything. DEV-403.
 *
 * `holdSeconds: 1` is `Trigger_Reset.cs:62`, `WaitForSeconds(1f)` between
 * `fader.trigger_FadeOut` and `Application.LoadLevel`. A call-site literal,
 * `trust: "code-default"`, with no prefab row. `boot/app.ts` fades the curtain
 * over the gameplay fader's own `fadeTime` (`LOAD_FADE_SECONDS`, 1 s), as
 * `Trigger_Reset` does. DEV-342's stranded tank borrows this second (below):
 * it is the same death with a different cause.
 */
export const HEAD_STRIKE: HeadSpec = { holdSeconds: 1 }

/**
 * Does the head strike apply to this seat? Matt, 2026-09-25: every JumpSeat,
 * the jumping spider included (*"it's a reset since players can't flip
 * themselves over"*). Later the same night, shown what teaching the spider's
 * hop planner had found, he chose to land the rule for the seats that climb
 * and exempt the spider until that planner flies clear of it on all six
 * courses. It does not yet: it traps itself under `rookie_02_jumpSeat`'s low
 * finish pad, and its steepest glide cannot stand up in time near a cliff.
 * `tests/unit/variant-spider.test.ts` is the gate a variant passes before it
 * is offered at all. A TEMPORARY deviation from his first call: DEV-403's row
 * says so, and `docs/plan/JUMPSEAT-HEAD-CRASH.md` §9 has the planner's work.
 *
 * Keyed on the MECHANIC, as the autopilot's dispatch is (`stepJumpSeatPilot`
 * hands a seat that carries a jump to the hop planner): the exemption exists
 * because of that planner, not because of a variant's name. The game and the
 * headless harness both ask this, so neither flies a rule the other does not.
 */
export const headStrikeApplies = (seat: JumpSeat): boolean => seat.jump === null

/**
 * `collider_head`'s box, off a collider list: the sheet's for `standard`, a
 * variant's view for the others, the list the hull is built from. DEV-403.
 *
 * Exported so `tests/unit/helpers/jumpseat-run.ts` tests the box the game tests.
 * THROWS when the list has no live `collider_head`: a JumpSeat without its head
 * cannot die the way 2016's does, and a silent fallback would ship that.
 */
export const jumpSeatHeadBox = (
  colliders: readonly (Pick<
    CraftColliderInput,
    'enabled' | 'centerInShipRootSpace' | 'composedFromShipRoot'
  > & {
    readonly name: string
    readonly effective: Pick<CraftColliderInput['effective'], 'halfExtents'>
  })[],
): HeadBox => {
  const head = colliders.find((c) => c.name === 'collider_head' && c.enabled)
  const half = head?.effective.halfExtents
  if (!head || !half) throw new Error('no live collider_head box on the JumpSeat — DEV-403')
  // Unity space in the sheet, which IS sim space: the hull reads these
  // centres the same way (`hullFromColliders`).
  return headBox({
    centre: head.centerInShipRootSpace,
    rotation: head.composedFromShipRoot.rotation,
    halfExtents: half,
  })
}

/**
 * When a dry seat has lost the run, and how it goes. DEV-342, Matt's call.
 *
 * `sim/jumpseat-stranded.ts` is the rule and holds no numbers; these are them,
 * and only the first two are FF2's:
 *
 *   · `restSeconds: 3` — Matt, 2026-09-24, choosing the restart: *"thruster
 *     out, outside every refuel sphere, at rest for 3 s"*. A first guess in
 *     DEV-080's sense, and long enough that a seat bouncing off a landing is
 *     not judged mid-bounce.
 *   · `verticalSpeed: 2` — m/s. Any value far below |g| x restSeconds / 2 = 48
 *     separates a carried seat from a falling one; at 2, free fall crosses the
 *     band in 2 x 2 / 32 = 0.125 s. The sim module's header has the measurement
 *     that made it vertical rather than total: a tilted dry seat sails at
 *     4.2 m/s for ever.
 *   · `holdSeconds: 1` — 2016's OWN JumpSeat death, `HEAD_STRIKE`'s, read
 *     from there rather than written twice. `Trigger_Reset.cs:60-64` (on
 *     `collider_head`) sets `fader.trigger_FadeOut`, `WaitForSeconds(1f)`, then
 *     reloads the scene; DEV-403 ports that rule itself.
 */
export const STRANDED: StrandedSpec = {
  restSeconds: 3,
  verticalSpeed: 2,
  holdSeconds: HEAD_STRIKE.holdSeconds,
}

/**
 * How long "OUT OF FUEL" stays up: the whole of the wait and then the fade, so
 * the reason is on screen until the screen is black. One name, because
 * `tests/unit/hud-redraw.test.ts` imports every banner window it cannot parse.
 */
export const STRANDED_BANNER_SECONDS = STRANDED.restSeconds + STRANDED.holdSeconds

/**
 * Exported for `tests/unit/jumpseat-flight.test.ts`, and not only for
 * convenience: this and `markerFor` are the two places the seam READS CONTENT,
 * which makes them the two places a stale extractor field can put the ship in
 * the wrong county. They get their own tests.
 */
export const startSpecFor = (level: Level): JumpSeatStartSpec => {
  const spawn = level.spawn as unknown as {
    enableJumpSeatDelay?: number | null
    enableJumpSeatCount?: number | null
  }
  return {
    triggerDelaySeconds: spawn.enableJumpSeatDelay ?? SHIPPED_START.triggerDelaySeconds,
    countdownSeconds: spawn.enableJumpSeatCount ?? SHIPPED_START.countdownSeconds,
  }
}

/**
 * Where the ship is when the scene loads.
 *
 * `markerUsedAtLoad` is emitted by the extractor and is `"respawn"` in all six
 * JumpSeat missions. It is not in `level-schema.ts` yet, hence the narrow read —
 * and the JSON is the authority when the two disagree (CLAUDE.md, "the two
 * generated trees are the port"). Defaulting to `respawn` rather than to `spawn`
 * is deliberate: `spawn` is the wrong marker for every JumpSeat mission, so the
 * fallback has to be the one that is right.
 */
export const markerFor = (level: Level) => {
  const named = (level as unknown as { markerUsedAtLoad?: string | null }).markerUsedAtLoad
  return named === 'spawn' ? level.spawn : level.respawn
}

/**
 * Every live pad's refuel sphere, SIM space.
 *
 * Exported for `tests/unit/jumpseat-refuel.test.ts` for the reason `markerFor`
 * is: this is a place the seam READS CONTENT, which makes it a place a stale
 * extractor field can silently stop a mission being completable.
 */
export const refuelSpheresFor = (level: Level): RefuelSphere[] => {
  const spheres: RefuelSphere[] = []
  for (const pad of livePads(level)) {
    const refuel = pad.refuel
    if (!refuel?.live) continue
    // `Trigger_Refuel.refuelRate` rides in on the volume since DEV-121 (10 on
    // every shipped pad). A volume without one is a stale JSON, and refusing it
    // is better than a pad that quietly refuels at nothing.
    if (refuel.rate === undefined) {
      throw new Error(
        `${level.id}: pad "${pad.name}" refuel volume carries no rate — run pnpm extract:levels`,
      )
    }
    // THREE space -> SIM space: the z flip, the same one every pad zone goes
    // through in `game/targets.ts`.
    spheres.push({
      centre: v3(refuel.pos[0], refuel.pos[1], -refuel.pos[2]),
      radius: refuel.radius,
      rate: refuel.rate,
    })
  }
  return spheres
}

/**
 * Every live pad's LANDING SURFACE as a `HeightField` the ground rule already
 * understands (DEV-120). Appended to the terrain the hull, the hover ray and the
 * legs collide with — see `setTerrain`.
 *
 * Exported for the same reason `refuelSpheresFor` is: this is a place the seam
 * reads content, and `tests/unit/helpers/jumpseat-run.ts` flies over the same
 * pads the game does rather than its own idea of them.
 *
 * THREE space -> SIM space: the z flip on the position, and on the quaternion
 * the mirror negates x and y — `threeQuatTupleToUnity`'s rule, written out here
 * because the sim types are plain objects and the render helper wants three's.
 */
export const padFieldsFor = (level: Level): HeightField[] => {
  const fields: HeightField[] = []
  for (const pad of livePads(level)) {
    const solid = pad.solid
    if (!solid?.live) continue
    fields.push(
      buildPadField({
        centre: v3(solid.pos[0], solid.pos[1], -solid.pos[2]),
        orientation: { x: -solid.quat[0], y: -solid.quat[1], z: solid.quat[2], w: solid.quat[3] },
        symmetry: solid.symmetry,
        profile: solid.profile,
        outer: solid.outer,
        // Its underside (DEV-383): a seat UNDER a floating pad is not inside it.
        bottom: solid.bottom,
      }),
    )
  }
  return fields
}

/** The seat's foot contacts, or null for a HoverJet — the narrowing `boot/app.ts` uses. */
export const contactProbesOf = (flight: Flight): readonly ContactProbe[] | null =>
  (flight as Partial<JumpSeatFlight>).contactProbes ?? null

/** A named collider out of the sheet, or undefined. */
const colliderNamed = (name: string) =>
  JUMPSEAT.shipCollisionColliders.find((c) => c.name === name && c.enabled)

/**
 * Where the eye sits, in the ship's frame.
 *
 * The pilot's head has a collider — `collider_head` `&174574`, a BoxCollider
 * centred at ship-root (0, 1.95, 0.04) — and that centre is the least invented
 * eye position available: it is a measured point on the shipped prefab that
 * exists precisely because a head is there. It replaces a guess, and it is read
 * from the sheet rather than copied out of it.
 *
 * TODO(extract): the JumpSeat's real camera root is `CameraRootObj &167436` and
 * the extractor does not walk the ship prefab's transform tree yet — the
 * HoverJet's `EYE` in `flight.ts` carries the same TODO. When it does, prefer
 * that node.
 *
 * Unity space in the comment, three space in the code, so z is negated.
 */
const headCollider = colliderNamed('collider_head')
export const JUMPSEAT_EYE = new THREE.Vector3(
  headCollider?.centerInShipRootSpace.x ?? 0,
  headCollider?.centerInShipRootSpace.y ?? 1.95,
  -(headCollider?.centerInShipRootSpace.z ?? 0.04),
)

/**
 * The four leg BODIES, in three space — the centre of mass of each, not the
 * foot. (The name predates the legs being simulated; the footprint it measures
 * is still the one the tests want.)
 *
 * `JUMPSEAT.legs[].composedPosition` is the leg rigidbody's origin in ship-root
 * space: (±1.5, −0.45, −1.48) aft and (±1.5, −0.45, +1.56) fore. The fore/aft
 * split is **asymmetric about the origin**, which is the property a mirrored or
 * wrong-handed import preserves the left/right half of and breaks.
 */
export const JUMPSEAT_FEET: readonly THREE.Vector3[] = JUMPSEAT.legs.map(
  (leg) =>
    new THREE.Vector3(leg.composedPosition.x, leg.composedPosition.y, -leg.composedPosition.z),
)

/**
 * The JumpSeat's own autopilot, hanging off its own `Flight`.
 *
 * `?autopilot=1` is HoverJet-shaped in `boot/app.ts` — `nextGate`, the ring
 * course, the authored racing line, `autopilotActions` — and none of it applies
 * to a vehicle that thrusts along body +Y at a dartboard. It lives HERE, on the
 * seam that owns the vehicle, for the reason the refuel does: the pilot needs
 * the seat's fuel, its tuning and its `live` flag, and `Flight` deliberately
 * exposes only `jet.body`. Handing those out through the interface would put a
 * JumpSeat's insides on the HoverJet's type.
 *
 * So `boot/app.ts` needs three additive lines and NO change to its HoverJet
 * path. See `jumpSeatAutopilotOf`.
 */
export interface JumpSeatAutopilotSeam {
  /**
   * The terrain the CONTROLLER avoids — `app.ts`'s `autopilotTerrain`, which is
   * the islands only. Deliberately NOT the same list as `setTerrain`'s: what a
   * hull HITS includes the 262 km ocean plate, and a controller given that would
   * spend the run climbing away from a sea level it is already 150 m above.
   */
  setAvoidTerrain(fields: readonly HeightField[]): void
  /**
   * One FIXED step of pilot intent. Call it once per sim step, never per frame
   * (DEV-027), and feed the result straight to `flight.step`.
   *
   * `padTaken` is `mission.targets.padTaken` — the scorer's own latch. Passing
   * an empty array still flies: the pilot falls back to a containment test
   * against the plate itself, which is what a mode with no pad scoring
   * (`int_02_jumpSeat`, forced to Free Flight) gets.
   */
  step(padTaken: readonly boolean[]): FlightActions
  /** Cursor, phase, diversions and abandonments. For a console line, not for logic. */
  readonly pilot: JumpSeatPilot
  /** Straight-line length of the planned tour, metres. Derived, for the same line. */
  readonly routeMetres: number
}

/** A `Flight` that carries one. Declared here so `game/flight.ts` needs no edit. */
/**
 * What 2016's three effect scripts read, for `game/particle-fx.ts` (DEV-416).
 *
 * `Thruster.Update` plays `thruster_fx` while `gasVal > 0` and `boost_fx` while
 * `boostVal > 0.05`; `HoverMotor.FixedUpdate` puts `ground_fx` at the ray's hit
 * while it finds ground within twice `hoverHeight` and the thruster is thrusting;
 * `JumpSeat_EffectsManager.Update` plays `windEffects` by velocity MAGNITUDE.
 * The Thruster and the HoverMotor ship DISABLED on the prefab and
 * `Trigger_EnableJumpShip` turns them on at GO, so neither burns before it.
 */
export interface SeatEffects {
  /** The seat is live, its thruster lit (fuel), and the throttle is open. */
  readonly thrusting: boolean
  /** As `thrusting`, past the sim's own `boostDeadzone` (2016's `boostVal > 0.05`). */
  readonly boosting: boolean
  /** `motorActivated`: the hover ray found ground within twice `hoverHeight`. */
  readonly hoverActive: boolean
  /** Metres from the body along its own down axis to that ground. */
  readonly hoverDistance: number
  /** `|velocity|`, m/s. */
  readonly speed: number
}

export interface JumpSeatFlight extends Flight {
  /** DEV-416. The state the seat's own particle systems follow. */
  readonly seatEffects: SeatEffects
  readonly jumpSeatAutopilot: JumpSeatAutopilotSeam
  /**
   * The four feet, swept over the last step, for the mission's plate test
   * (DEV-120). `boot/app.ts` hands them to `stepMission` through the levers;
   * a HoverJet has none and the mission sweeps the body as before.
   */
  readonly contactProbes: readonly ContactProbe[]
}

/**
 * The JumpSeat autopilot on this flight, or null for a HoverJet.
 *
 * The narrowing `boot/app.ts` uses, so that the `?autopilot=1` branch reads
 * "this vehicle brought its own controller, or it did not" rather than
 * re-deriving the vehicle from the level.
 */
export const jumpSeatAutopilotOf = (flight: Flight): JumpSeatAutopilotSeam | null =>
  (flight as Partial<JumpSeatFlight>).jumpSeatAutopilot ?? null

/** The seat's effect state, or null for any other vehicle. DEV-416. */
export const seatEffectsOf = (flight: Flight): SeatEffects | null =>
  (flight as Partial<JumpSeatFlight>).seatEffects ?? null

/**
 * One stop per live pad: **the bullseye PLATE**, not the pad's origin.
 *
 * They are three metres apart vertically — the bullseye box spans pad-local y
 * −4.30 .. −1.69 — and under the accuracy streak that is the whole difference
 * between a multiplier that builds and one that resets. The `TargetZone` itself
 * is carried rather than a point, so the pilot's "have I arrived" and the
 * scorer's "did that score" are the same volume; see `JumpSeatWaypoint`.
 *
 * Exported because `tests/unit/helpers/jumpseat-run.ts` flies the same route the
 * game does. A harness with its own copy of this would agree with the seam right
 * up until one of them changed (CLAUDE.md, "the agreement lesson").
 */
export const autopilotWaypointsFor = (level: Level): JumpSeatWaypoint[] => {
  const zones = padZones(level)
  const pads = livePads(level)
  const waypoints: JumpSeatWaypoint[] = []
  for (let pad = 0; pad < pads.length; pad++) {
    let best: TargetZone | undefined
    for (const zone of zones) {
      if (zone.pad !== pad) continue
      if (!best || zone.points > best.points) best = zone
    }
    if (!best) continue
    // The pad's rim, relative to the plate the pilot is aiming at (DEV-120).
    // `solid.pos[1] + solid.top` is the highest surface in either space — y is
    // not flipped between THREE and SIM — and the plate centre is SIM already.
    const solid = pads[pad]?.solid
    const padTop = solid ? solid.pos[1] + solid.top - best.centre.y : 0
    // And the rest of the slab, for the rim rule (DEV-403): its radius, and its
    // underside relative to the same plate.
    const slab = solid
      ? { padRadius: solid.outer, padBottom: solid.pos[1] + solid.bottom - best.centre.y }
      : {}
    waypoints.push({ ...best, padTop, ...slab })
  }
  return waypoints
}

/**
 * The pad that carries `Trigger_Finish_JumpSeat`, or -1.
 *
 * Pinned LAST in the tour: crossing the slab ends the run, so a route that met
 * it in the middle would stop there with half a board unflown.
 */
export const autopilotFinishPad = (level: Level): number => finishPadAirspace(level)?.pad ?? -1

/**
 * The panel this vehicle asks for: whatever the caller pinned (raster, cadence
 * arms), drawn as 2016's JumpSeat readout — one fuel gauge — rather than the
 * HoverJet's three rows. DEV-360, on both presets: it is a restoration.
 *
 * Exported so a node test can hold the one fact that matters here — that the
 * JumpSeat's panel is `HUD_LAYOUT_JUMPSEAT` — without loading the art.
 */
export const jumpSeatHudOptions = (hudOptions: HudOptions): HudOptions => ({
  ...hudOptions,
  layout: HUD_LAYOUT_JUMPSEAT,
})

/**
 * Hang the art where 2016's prefab hangs it (DEV-365). The seat, the shell and
 * the engines go on the art pivot, in ITS frame — the art is built in the
 * ship's frame, so it hangs at the ship's origin as the pivot sees it. The legs
 * go on the SHIP: 2016 puts `legs_front` and `legs_back` on `offset`, beside
 * `art_pivot (1)`, so the lean swings the seat and not the legs standing on the
 * pad. Exported so `tests/unit/art-pivot.test.ts` measures this and not a copy.
 */
export const hangJumpSeatArt = (
  ship: THREE.Object3D,
  artPivot: THREE.Object3D,
  art: JumpSeatArt,
): void => {
  art.object.position.copy(onPivot({ x: 0, y: 0, z: 0 }, JUMPSEAT_ART_PIVOT))
  artPivot.add(art.object)
  ship.add(art.legs)
}

/**
 * A device's actions as the seat's input: the ONE place the seam maps them,
 * exported so a test can put every device's both-triggers gesture through the
 * game's own line (DEV-383: on a spider that gesture is the charge).
 *
 * The JumpSeat's boost is ANALOG (`Input_Manager.cs:220-231`, the left
 * trigger's value while the right trigger is held) and `FlightActions` carries
 * a boolean, so full-or-nothing is the best this input layer can say.
 * HANDOVER: an analog `boostValue` on `FlightActions` would make the reachable
 * [0.165, 1.65] band playable; the model already takes it.
 */
export const jumpSeatInputOf = (actions: FlightActions, out: JumpSeatInput): JumpSeatInput => {
  out.throttle = actions.throttle
  out.boost = actions.boost ? 1 : 0
  out.pitch = actions.pitch
  out.yaw = actions.yaw
  out.roll = actions.roll
  return out
}

/**
 * The seat a variant flies: 2016's sheet scaled by its multipliers, plus its
 * mechanics (DEV-384's `gravityScale`). The ONE place the seam builds a seat,
 * exported so `tests/unit/helpers/jumpseat-run.ts` flies the seat the game
 * builds rather than a second opinion about it. `standard` is
 * `createJumpSeat(JUMPSEAT, {})`, which is `createJumpSeat()`.
 *
 * The mechanics arrive validated (`content/aircraft-schema.ts` refuses a
 * `gravityScale` that is not a finite number above zero), so this only picks
 * the typed fields out of them. The jump (DEV-383) goes through
 * `validateJump` again here rather than a cast: a `FlightVariant` built by
 * hand in a test never met the file validator, and a malformed jump is a
 * seat that launches at NaN.
 */
export const jumpSeatFor = (variant: FlightVariant = STANDARD_FLIGHT_VARIANT): JumpSeat => {
  const gravityScale = variant.mechanics.gravityScale
  const jump = variant.mechanics.jump
  const mechanics: JumpSeatMechanics = {
    ...(typeof gravityScale === 'number' ? { gravityScale } : {}),
    ...(jump !== undefined ? { jump: validateJump(jump, variant.id) } : {}),
  }
  return createJumpSeat(jumpSeatView(variant.scale), mechanics)
}

export const loadJumpSeatFlight = async (
  level: Level,
  hudPlacement: EditionHudPlacement,
  // DEV-256. See `loadFlight`, which threads this through.
  hudOptions: HudOptions = {},
  // DEV-380. The aircraft variant, resolved by the caller; see `loadFlight`.
  variant: FlightVariant = STANDARD_FLIGHT_VARIANT,
): Promise<JumpSeatFlight> => {
  // The seat's numbers, as a VIEW of 2016's sheet (`standard`'s is the sheet).
  const sheet = jumpSeatView(variant.scale)
  const object = new THREE.Group()
  object.name = 'jumpseat'
  // At 2016's `art_pivot (1)`, the point the lean turns the seat about
  // (DEV-365, `game/art-pivot.ts`); `applyPivot` holds it there.
  const artPivot = new THREE.Group()
  artPivot.name = 'art_pivot'
  artPivot.position.copy(JUMPSEAT_ART_PIVOT)
  // 2016's own meshes, placed by the sheet (DEV-114). Three GLBs, awaited
  // together: a seat that appears before its shell is a seat that flickers.
  const art = await loadJumpSeatArt()
  hangJumpSeatArt(object, artPivot, art)
  object.add(artPivot)

  // The same cockpit furniture the HoverJet wears — all first-party, no assets,
  // and the mission flow in `app.ts` drives it identically whichever ship it is.
  // Positions are relative to THIS vehicle's eye, which is a metre higher than
  // the jet's.
  // The readout's seat is the preset's (`cockpit.placement.jumpSeatHud`,
  // DEV-129), from THIS eye — its own block since DEV-362 set the HoverJet's
  // into its dash; the numbers are the ones both vehicles shared. What it
  // DRAWS is 2016's JumpSeat instrument, the fuel dome (DEV-360) — see
  // `jumpSeatHudOptions`.
  const hud = createHud(jumpSeatHudOptions(hudOptions))
  const placeHud = (p: EditionHudPlacement): void => {
    hud.object.position.set(
      JUMPSEAT_EYE.x + p.offset[0],
      JUMPSEAT_EYE.y + p.offset[1],
      JUMPSEAT_EYE.z + p.offset[2],
    )
    hud.object.rotation.set(p.tilt, 0, 0)
    hud.object.scale.setScalar(p.scale)
  }
  placeHud(hudPlacement)
  object.add(hud.object)
  // The next-gate arrow (DEV-124) — the next open PAD on this vehicle. Same
  // mount as the HoverJet's: on the ship, offset from this vehicle's own eye.
  const nextGateArrow = createNextGateArrow()
  object.add(nextGateArrow.object)

  const results = createResults()
  results.object.position.set(0, JUMPSEAT_EYE.y + 0.02, JUMPSEAT_EYE.z - 0.95)
  object.add(results.object)

  const briefing = createBriefing()
  briefing.object.position.set(0, JUMPSEAT_EYE.y + 0.2, JUMPSEAT_EYE.z - 1.05)
  briefing.object.rotation.x = 0.12
  object.add(briefing.object)

  const pause = createPause()
  const pauseAt = pausePlateOffset()
  pause.object.position.set(0, JUMPSEAT_EYE.y + pauseAt[1], JUMPSEAT_EYE.z + pauseAt[2])
  object.add(pause.object)

  // `jumpSeatFor` builds the same view again and adds the mechanics (DEV-384).
  const seat = jumpSeatFor(variant)
  // Free Flight turns the burn off (`FuelManager.cs:30`). In 2016 that was keyed
  // on a `PlayerPrefs` string which `Level.ForceGameMode` never wrote — so
  // `int_02_jumpSeat`, the forced-Free-Flight mission, still burned fuel. Keying
  // it on the mode actually running is the deviation, and it is the improvement.
  //
  // Through the DESCRIPTOR and the RUNNING mode, not `level.mode !== 'freeFlight'`:
  // the rule belongs to the mode rather than to the vehicle, and the default mode
  // is the wrong question the day a mode select exists. `mode-rules.test.ts`'s
  // structural guard held this file on an allowlist until it read this way.
  seat.burnsFuel = rulesFor(runningMode(level)).burnsFuel

  const start = createJumpSeatStart()
  const startSpec = startSpecFor(level)

  // The pads' refuel spheres. Built once from the level, because they never
  // move — `Trigger_Refuel` is a static trigger on a static prefab.
  const refuel = createRefuel(refuelSpheresFor(level))
  // The pads' landing surfaces (DEV-120). Static, like the refuel spheres, and
  // appended to whatever terrain `setTerrain` hands over.
  const padFields = padFieldsFor(level)
  // DEV-342: a dry seat no sphere can reach. PER FLIGHT, and `strandedView` is
  // what `boot/app.ts` reads — rewritten every step, never allocated per read.
  const stranded = createStranded()
  const strandedView: { phase: StrandedPhase; restart: boolean } = { phase: 'ok', restart: false }
  // DEV-403: 2016's own JumpSeat death, the pilot's head touching anything.
  // Same shape as the stranded view, and stepped with it (`stepJumpSeatDeaths`).
  const head = createHead()
  const headView: { phase: HeadPhase; restart: boolean } = { phase: 'ok', restart: false }
  // The box off the collider list the hull is built from, so a variant's view
  // moves both together.
  const HEAD_BOX = jumpSeatHeadBox(
    sheet.shipCollisionColliders as unknown as Parameters<typeof jumpSeatHeadBox>[0],
  )
  // What the head can touch beyond `terrainFields` (the land, the sea, and the
  // pads to their undersides, the list the hull collides with): on a preset
  // whose props collide, the forest (`setProps`).
  let headProps: PropColliders | null = null
  // DEV-383: the spider's jump as the HUD and `__ff2` read it, rewritten every
  // step, never allocated per read — and the body's vertical velocity change
  // over the last fixed step, for the comfort vignette's linear term.
  const jumpView = { charge: 0, firing: false, jumps: 0 }
  let verticalAcceleration = 0

  const collision = createTerrainCollision()
  const baseAngularDrag = seat.body.angularDrag
  const COLLISION: TerrainCollisionSpec = {
    hull: hullFromColliders(
      sheet.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
    ),
    // The HoverJet's own contact values (`SHIP_GROUND_CONTACT`): Unity's default
    // material, and a hull that bounced would turn every hard landing into a
    // pinball, which on a LANDER is most landings.
    ...SHIP_GROUND_CONTACT,
  }
  let terrainFields: readonly HeightField[] = []
  let struck = false
  /** G1's input (DEV-110). Same hull, same fields, same query as the HoverJet's. */
  let clearance = Number.POSITIVE_INFINITY

  // `Rotator_Input` off the sheet — the JumpSeat has one too, on `art_pivot (1)`.
  //
  // KNOWN DIVERGENCE: the JumpSeat's rotator has `shipInput: null` and
  // `inputManager: &11411946`, and `Rotator_Input.cs:164-197` puts the ENTIRE
  // pitch-reset half inside `if (shipInput != null)` — so on this vehicle the
  // art pitch never returns to zero, it sticks at its last non-zero value until
  // the stick moves again. `src/sim/art-lean.ts` implements the HoverJet's
  // branch and has no flag for that yet (spec W-5, a one-option change in a file
  // this session does not own). Visual only; noted so it is not rediscovered.
  const rotator = JUMPSEAT.artRotator
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
    // NULL — see `ArtLeanTuning.resetPitch`.
    resetPitch: rotator.shipInput.ref !== null,
  })

  const marker = markerFor(level)
  const placeAtMarker = () => {
    // The level JSON is THREE space; the sim is UNITY space. Seeding the body
    // with an unconverted quaternion gives a ship that flies perfectly well
    // backwards, which is exactly what happened to the HoverJet the first time.
    threeTupleToUnity(seat.body.position, marker.pos as number[])
    threeQuatTupleToUnity(seat.body.orientation, marker.quat as number[])
    seat.body.velocity.x = 0
    seat.body.velocity.y = 0
    seat.body.velocity.z = 0
    seat.body.angularVelocity.x = 0
    seat.body.angularVelocity.y = 0
    seat.body.angularVelocity.z = 0
  }
  placeAtMarker()

  const previous = {
    position: { x: seat.body.position.x, y: seat.body.position.y, z: seat.body.position.z },
    orientation: {
      x: seat.body.orientation.x,
      y: seat.body.orientation.y,
      z: seat.body.orientation.z,
      w: seat.body.orientation.w,
    },
  }
  const current = {
    position: { ...previous.position },
    orientation: { ...previous.orientation },
  }
  // The legs get the same two-state interpolation as the pose. They are sim
  // state stepped at 81.967 Hz and drawn at whatever the headset runs at, so
  // reading the live angle straight into the mesh would judder exactly the way
  // reading the live position would.
  const previousAngles = [0, 0, 0, 0]
  const currentAngles = [0, 0, 0, 0]
  const drawnAngles = [0, 0, 0, 0]
  const syncPose = () => {
    previous.position.x = current.position.x = seat.body.position.x
    previous.position.y = current.position.y = seat.body.position.y
    previous.position.z = current.position.z = seat.body.position.z
    previous.orientation.x = current.orientation.x = seat.body.orientation.x
    previous.orientation.y = current.orientation.y = seat.body.orientation.y
    previous.orientation.z = current.orientation.z = seat.body.orientation.z
    previous.orientation.w = current.orientation.w = seat.body.orientation.w
  }

  const input = noJumpSeatInput()

  // ── The autopilot, built once ───────────────────────────────────────────
  //
  // The route is the tour of the live pads' BULLSEYES with the finish pad pinned
  // last — the plate boxes themselves, straight out of `padZones`, so the
  // pilot's "have I arrived" and the scorer's "did that score" are the same
  // volume rather than two descriptions of one. `finishPadAirspace` names which
  // pad carries `Trigger_Finish_JumpSeat`, and crossing it ends the run, so a
  // tour that met it in the middle would stop there with half a board.
  const autopilotRoute = planJumpSeatRoute(
    autopilotWaypointsFor(level),
    // Where the ship IS at load, not `spawn.pos`: see `markerFor`.
    { x: seat.body.position.x, y: seat.body.position.y, z: seat.body.position.z },
    autopilotFinishPad(level),
  )
  const pilot = createJumpSeatPilot(autopilotRoute)
  // The head guard (DEV-403): the pilot keeps the same head off the same
  // fields, rebuilt by `setTerrain` and `setProps` when those change.
  pilot.head = { box: HEAD_BOX, surfaces: terrainFields, props: headProps }
  const pilotInput = noJumpSeatInput()
  let avoidTerrain: readonly HeightField[] = []
  const pilotActions: FlightActions = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0,
    boost: false,
    brake: false,
    airbrake: false,
  }

  const lerpPos = new THREE.Vector3()
  const slerpQuat = new THREE.Quaternion()
  const a = new THREE.Quaternion()
  const b = new THREE.Quaternion()
  const eyeWorld = new THREE.Vector3()
  const tmp = new THREE.Vector3()

  // The same pivot seam the HoverJet has, for the same reason — the stand-in
  // hangs off `art_pivot` and the camera comes off `object`, so a buffet here
  // cannot reach the eye. See the long note on `applyPivot` in `flight.ts`;
  // this sample is this vehicle's own, never shared (trap 19).
  //
  // The JumpSeat's prefab carries no boost systems, so `boostStage` keeps it at
  // 0 and it buffets on speed alone. That is the honest answer rather than a
  // ladder invented for a vehicle 2016 gave none — DEV-083.
  const buffet = createShakeSample()
  const applyPivot = (): void => {
    // About `art_pivot (1)`'s own point, not the ship's origin (DEV-365).
    poseArtPivot(artPivot, JUMPSEAT_ART_PIVOT, lean.currentPitch, lean.currentRoll, buffet)
  }

  // ── DEV-246: the seat is drawn BEFORE the world it is flying over ─────
  //
  // Thrown at construction for DEV-241 §3's reason, and on this vehicle it is
  // very nearly a no-op in the sequence: measured on `adv_02_jumpSeat`
  // (`tests/e2e/draw-order-cockpit.spec.ts`), the whole group was already one
  // run at the HEAD of the colour pass, because `material.id` happened to put
  // it there. That is the point — it is the same accident the HoverJet's
  // cockpit interior fell the other way on, and the two vehicles differing
  // with nobody having chosen either is the argument for pinning both. This
  // mission is therefore DEV-246's negative control: its A/B arm must read
  // zero.
  //
  // There is no lazy cabin here (`setInterior` is a documented no-op on this
  // vehicle), so unlike the HoverJet's this one call is the whole of it.
  setCockpitFirst(object, true)

  return {
    // The JumpSeat's own body, and an INERT speed chain — it has none. See
    // `FlightShip` in `flight.ts`: `app.ts` calls `chainGate()` on every scored
    // gate and nothing in `stepJumpSeat` ever consults a chained ceiling, so
    // this is a well-behaved no-op rather than a lie about the vehicle.
    jet: { body: seat.body, chain: createSpeedChain() },
    variant: variant.id,
    lean,
    hud,
    nextGateArrow,
    eye: JUMPSEAT_EYE,
    pivot: JUMPSEAT_ART_PIVOT,
    results,
    pause,
    briefing,
    object,

    jumpSeatAutopilot: {
      pilot,
      routeMetres: routeLength(autopilotRoute, {
        x: seat.body.position.x,
        y: seat.body.position.y,
        z: seat.body.position.z,
      }),
      setAvoidTerrain(fields: readonly HeightField[]) {
        avoidTerrain = fields
      },
      step(padTaken: readonly boolean[]) {
        // The jumping spider (DEV-383) plans each hop over what its hull lands
        // on — the pads and the sea as well as the land — so it is handed the
        // collision list; a seat that climbs avoids the land alone.
        const fields = seat.jump ? terrainFields : avoidTerrain
        stepJumpSeatPilot(pilot, seat, pilotInput, padTaken, fields, undefined, FIXED_DT)
        pilotActions.pitch = pilotInput.pitch
        pilotActions.yaw = pilotInput.yaw
        pilotActions.roll = pilotInput.roll
        pilotActions.throttle = pilotInput.throttle
        // `FlightActions.boost` is a BOOLEAN and the JumpSeat's is analog
        // (`Input_Manager.cs:220-231`), so this is the same lossy step the human
        // path takes in `step()` below — the controller asks for 0 or 1 anyway.
        pilotActions.boost = pilotInput.boost > 0
        // Neither exists on this vehicle: `Input_Manager.cs:234-244` reads the
        // brake button into empty `if` bodies and there is no airbrake.
        pilotActions.brake = false
        pilotActions.airbrake = false
        // ONE object, reused, and it is handed straight back to the caller that
        // asked for it — never stored, never read on a later tick. There is one
        // JumpSeat per run, so unlike `ai-racer.ts` there is nobody to inherit
        // from; the reuse is an allocation choice, not a channel. (Trap 19.)
        return pilotActions
      },
    },

    placeAt(position, orientation, velocity) {
      // The `Flight` contract (DEV-126's crash reset). `app.ts` runs that rule
      // for the HoverJet only: the JumpSeat's crash is 2016's own head strike
      // (DEV-403), which restarts the run through `respawn` rather than placing
      // the seat. Kept so a `Flight` can always be placed. The pose and velocity, at rest otherwise, and the
      // interpolation collapsed onto it; the gear and the tank are left alone,
      // because this is a move and not a reload (`respawn` is the reload).
      seat.body.position.x = position.x
      seat.body.position.y = position.y
      seat.body.position.z = position.z
      seat.body.orientation.x = orientation.x
      seat.body.orientation.y = orientation.y
      seat.body.orientation.z = orientation.z
      seat.body.orientation.w = orientation.w
      seat.body.velocity.x = velocity.x
      seat.body.velocity.y = velocity.y
      seat.body.velocity.z = velocity.z
      seat.body.angularVelocity.x = 0
      seat.body.angularVelocity.y = 0
      seat.body.angularVelocity.z = 0
      if (seat.legs) resetJumpSeatLegs(seat.legs)
      syncPose()
    },

    get impactSpeed() {
      return collision.impactSpeed
    },

    respawn() {
      placeAtMarker()
      // 2016 reloads the scene on a respawn, which builds a fresh
      // `playerstart_jumpSeat` rig with a fresh `Trigger_EnableJumpShip` — so
      // the 7.5 s countdown runs AGAIN, and the engine, the tank and the ramp
      // all come back cold.
      start.elapsed = 0
      start.live = false
      seat.live = false
      seat.curveTime = 0
      seat.adjustedThrustForce = 0
      seat.appliedThrust = 0
      seat.fuel = seat.tuning.maxFuel
      seat.thrusterEnabled = true
      seat.dragHackEnabled = false
      seat.body.drag = seat.tuning.dragBase
      // The gear comes back in its authored pose, and — the half that matters —
      // UNPRIMED, so the teleport's velocity discontinuity is not differenced
      // into an acceleration of several thousand g on the next tick.
      if (seat.legs) resetJumpSeatLegs(seat.legs)
      // And the feet forget where they were: a sweep from the crash site to the
      // respawn marker would score every plate on the line between them.
      resetJumpSeatFootProbes(seat)
      // The pads' refuel triggers come back with the scene, like everything
      // else 2016 reloads on a respawn. Only the run TOTAL is cleared — the
      // spheres themselves are static and are not rebuilt.
      refuel.added = 0
      refuel.last = -1
      // And the stranded rule forgets the run it ended (DEV-342): a fresh tank
      // and a thruster that is lit are not stranded, and a `dying` left standing
      // would restart the new run one tick into its countdown.
      resetStranded(stranded)
      // The jump comes back empty with the scene (DEV-383): a charge held
      // across a restart is a charge the new run never paid for.
      if (seat.jump) resetJump(seat.jump)
      verticalAcceleration = 0
      strandedView.phase = 'ok'
      strandedView.restart = false
      // The head too (DEV-403): 2016's reload builds a fresh `Trigger_Reset`
      // with `triggered` false, and a `dying` left standing would end the new run.
      resetHead(head)
      headView.phase = 'ok'
      headView.restart = false
      // And the autopilot starts its tour again from the first pad, as the
      // run does. Left at the pad the run died on, it flew straight there
      // from the respawn marker, low, and struck its head again within three
      // seconds of every restart (`resetJumpSeatPilot`).
      resetJumpSeatPilot(pilot)
      previousAngles.fill(0)
      currentAngles.fill(0)
      syncPose()
    },

    rideElevator() {
      // DELIBERATE NO-OP. The JumpSeat never rides one — `StartLaunch()` is only
      // ever called from `Input_Ship*.cs` and this prefab has none. `app.ts`
      // still calls this while two of the six level JSONs carry a stale
      // `launchKind: "elevator"` copied off the HoverJet's rig; swallowing it
      // here is what keeps that extractor bug from moving the ship 2.7 km.
    },

    setTerrain(fields: readonly HeightField[]) {
      // The ground AND the pads (DEV-120): one list, so the hover ray, the
      // hull and the legs cannot disagree about what is under the seat. The
      // ocean is in here too on a Simonet mission, which is right — a pad over
      // water is a pad over water.
      terrainFields = [...fields, ...padFields]
      // The head and the pilot's head guard read the same list (DEV-403).
      pilot.head = { box: HEAD_BOX, surfaces: terrainFields, props: headProps }
    },

    setProps(colliders: PropColliders | null) {
      // DEV-403, Matt 2026-09-25: a head in a tree is a head strike, as in
      // 2016, where desert's and alpine's props carried live colliders
      // (DEV-214). `boot/app.ts` hands over the colliders its own prop
      // collision steps against and null when there are none, so the head
      // meets exactly the forest the rest of the seat does.
      // `app.ts` calls this every tick; the guard is rebuilt only on a change.
      if (colliders === headProps) return
      headProps = colliders
      // And the pilot keeps its head out of the same forest.
      pilot.head = { box: HEAD_BOX, surfaces: terrainFields, props: headProps }
    },

    get clearance() {
      return clearance
    },
    get struck() {
      return struck
    },
    get contactProbes() {
      return seat.footProbes
    },
    // THE TANK, for the panel (DEV-201). A getter and not a field for the same
    // reason `clearance` is one: it is a reading of where the seat is NOW, and a
    // snapshot taken when the flight was built would be `1` for ever.
    //
    // `fraction` is not clamped here. `seat.fuel` goes negative on purpose
    // (`sim/jumpseat.ts` — the burn is guarded on the throttle and on nothing
    // else, so holding it on a dead tank keeps digging) and the drawer clamps
    // what it draws. Clamping at the source would throw away the only signal
    // that says how long the pad has to work before the thruster relights.
    get fuel() {
      return { fraction: seat.fuel / seat.tuning.maxFuel, lit: seat.thrusterEnabled }
    },
    // DEV-343: `Trigger_EnableJumpShip` has not fired yet. The seat falls and
    // settles through its 7.5 s countdown, but the RUN — the scoring, the clock —
    // has not started, exactly as the HoverJet's has not while the lift holds it.
    get countdownHolds() {
      return !seat.live
    },
    // DEV-416. Read off the last step's input, as 2016's `Update` reads the
    // input manager; the hover ray is `stepJumpSeat`'s own.
    get seatEffects(): SeatEffects {
      const lit = seat.live && seat.thrusterEnabled
      const v = seat.body.velocity
      return {
        thrusting: lit && input.throttle > 0,
        boosting: lit && input.boost > seat.tuning.boostDeadzone,
        hoverActive: seat.hover.active,
        hoverDistance: seat.hover.distance,
        speed: Math.hypot(v.x, v.y, v.z),
      }
    },
    // DEV-342. See `STRANDED` and `sim/jumpseat-stranded.ts`.
    // DEV-383. Absent unless this seat's variant carries a jump.
    get jump() {
      return seat.jump ? jumpView : undefined
    },
    get verticalAcceleration() {
      return verticalAcceleration
    },
    get stranded() {
      return strandedView
    },
    // DEV-403. See `HEAD_STRIKE` and `sim/jumpseat-head.ts`.
    get headStrike() {
      return headView
    },

    step(actions: FlightActions) {
      previous.position.x = current.position.x
      previous.position.y = current.position.y
      previous.position.z = current.position.z
      previous.orientation.x = current.orientation.x
      previous.orientation.y = current.orientation.y
      previous.orientation.z = current.orientation.z
      previous.orientation.w = current.orientation.w
      for (let i = 0; i < previousAngles.length; i++) previousAngles[i] = currentAngles[i] ?? 0

      // `Trigger_EnableJumpShip`. Until it fires the seat has gravity and torque
      // and nothing else — so it falls, and stepping it anyway is what makes
      // that honest rather than a frozen ship hanging in the air.
      if (stepJumpSeatStart(start, startSpec, FIXED_DT)) seat.live = true

      jumpSeatInputOf(actions, input)
      // The hover motor and the DragHack switch live INSIDE `stepJumpSeat` —
      // unlike the HoverJet, where this seam calls `stepHoverMotor` itself. The
      // JumpSeat's motor owns which of its two drags is in force, and splitting
      // that coupling across two files is how it would get forgotten.
      const vyBefore = seat.body.velocity.y
      stepJumpSeat(seat, input, terrainFields, FIXED_DT)
      // DEV-403: the head, where the flight model PUT the seat — before the
      // contact resolves it, as PhysX generates a contact before it solves. A
      // head that reached a hillside touched it even when the chassis hit
      // harder and the resolve lifts the whole seat back out.
      // `sim/jumpseat-head.ts` has the reasoning. Not on a seat that jumps, yet:
      // `headStrikeApplies`.
      const headTouching =
        headStrikeApplies(seat) && headTouches(seat.body, HEAD_BOX, terrainFields, headProps)
      struck = stepTerrainCollision(collision, seat.body, terrainFields, COLLISION, FIXED_DT)
      // After the resolve, for the same reason the HoverJet does it there.
      clearance = hullClearance(seat.body, terrainFields, COLLISION)
      seat.body.angularDrag = collisionAngularDrag(collision, COLLISION, baseAngularDrag)
      // The feet, where they ended up this tick — AFTER the collision has placed
      // the body, so the mission scores the plate a foot actually stood on
      // (DEV-120; `ContactProbe` in `sim/targets.ts`).
      updateJumpSeatFootProbes(seat)
      // AFTER the body has moved, so a tick that flies into a pad is paid on
      // that tick — and after the collision, so a ship pushed out of the terrain
      // is judged where it ended up. See `sim/jumpseat-refuel.ts`.
      stepJumpSeatRefuel(refuel, seat, seat.body.position, FIXED_DT)
      // AFTER the refuel, so a tick that carries the seat into a sphere is judged
      // inside it (DEV-342). The head (DEV-403) is stepped WITH it: one death at a
      // time, and the order in which the two may take a run is written down once.
      const death = stepJumpSeatDeaths(
        head,
        stranded,
        headTouching,
        seat,
        refuel,
        HEAD_STRIKE,
        STRANDED,
        FIXED_DT,
      )
      strandedView.restart = death === 'fuel'
      strandedView.phase = stranded.phase
      headView.restart = death === 'head'
      headView.phase = head.phase
      stepArtLean(lean, actions.roll, actions.pitch, FIXED_DT)
      // After the collision has placed the body, so a landing's stop is in it.
      verticalAcceleration = (seat.body.velocity.y - vyBefore) / FIXED_DT
      if (seat.jump) {
        jumpView.charge = seat.jump.charge
        jumpView.firing = seat.jump.burstTicksLeft > 0
        jumpView.jumps = seat.jump.jumps
      }

      current.position.x = seat.body.position.x
      current.position.y = seat.body.position.y
      current.position.z = seat.body.position.z
      current.orientation.x = seat.body.orientation.x
      current.orientation.y = seat.body.orientation.y
      current.orientation.z = seat.body.orientation.z
      current.orientation.w = seat.body.orientation.w
      if (seat.legs) {
        for (let i = 0; i < currentAngles.length; i++)
          currentAngles[i] = seat.legs.legs[i]?.angle ?? 0
      }
    },

    render(alpha: number, camera: THREE.Camera, rig: THREE.Object3D | null) {
      lerpPos.set(previous.position.x, previous.position.y, previous.position.z)
      lerpPos.lerp(tmp.set(current.position.x, current.position.y, current.position.z), alpha)
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

      for (let i = 0; i < drawnAngles.length; i++) {
        const a = previousAngles[i] ?? 0
        drawnAngles[i] = a + ((currentAngles[i] ?? 0) - a) * alpha
      }
      art.setLegAngles(drawnAngles)

      // Unity space -> three space: position flips z, orientation negates x and y.
      applyUnityPose(object, lerpPos, slerpQuat)
      applyPivot()

      object.updateMatrixWorld(true)

      eyeWorld.copy(JUMPSEAT_EYE).applyQuaternion(object.quaternion).add(object.position)
      if (rig) {
        rig.position.copy(eyeWorld)
        rig.quaternion.copy(object.quaternion)
        // The camera is a CHILD of the rig, so its transform is LOCAL and the
        // XR runtime owns it in session. Out of session nothing does, and
        // whatever it held last persists — which once put the cockpit camera
        // three kilometres from the cockpit. Trap 18.
        camera.position.set(0, 0, 0)
        camera.quaternion.identity()
      } else {
        camera.position.copy(eyeWorld)
        camera.quaternion.copy(object.quaternion)
      }
    },

    shake(shake, scale, time, forwardSpeed, active, jolt = 0) {
      sampleCockpitShake(buffet, shake, scale, time, forwardSpeed, active, jolt)
      applyPivot()
    },

    setInterior(_cockpit) {
      // V8 / DEV-088 is the HoverJet's, and deliberately — still, now that the
      // real meshes are here (DEV-114), for a reason that is MEASURED rather
      // than assumed: the shell tops out at 1.70 m above the ship root
      // (`jumpseat_shell_04` y 1.016..3.136 in the art frame, root at -1.435)
      // and the eye is at 1.95 m on `collider_head`, 2016's own camera at
      // 1.829 m. The pilot's head is ABOVE the shell. This is an open VTOL
      // seat, research 05 §3.2's phrase, and there is no cabin for a fill light
      // to fill or a dark frame for an emissive floor to lift; the sun reaches
      // every surface a HoverJet cabin light exists to reach.
      //
      // A body in THIS seat is a real thing to want and is not this package's;
      // the `seat` node of `jumpseat-body.glb` is where it would go. Explicit
      // rather than omitted so that it has an obvious place to land.
    },

    setView(_view: ShipView) {
      // The HoverJet swaps a cockpit mesh for an exterior hull. The JumpSeat's
      // prefab has an `art_thirdPerson` branch too, `m_IsActive: 0`, and it is
      // a DUPLICATE of the first-person subtree — the same eleven renderers
      // (survey FIND-jumpseat-04, second pass) — so the same art is right from
      // inside and outside, and there is nothing to toggle.
    },

    setShipShadow(_on: boolean) {
      // Nothing to do, and for the same reason `setView` has nothing to do:
      // this vehicle draws one set of art from both views, so it is never
      // hidden and DEV-305's whole problem — a caster that is not in the
      // scene — cannot arise. `boot/app.ts` hands its meshes to the shadow map
      // the same way; whether they CAST is `shadowFlagsFor`'s answer and not
      // this method's.
    },

    placeHud,
    thirdPersonCamera: JUMPSEAT_THIRD_PERSON,
    thirdPersonChase: JUMPSEAT_THIRD_PERSON_CHASE,

    dispose() {
      hud.dispose()
      nextGateArrow.dispose()
      results.dispose()
      pause.dispose()
      briefing.dispose()
      art.dispose()
    },
  }
}

/**
 * Where 2016 PARKS the JumpSeat's camera rig, off the sheet. DEV-128.
 *
 * `CamChanger.camTargets[1]`: `offset/CamRoot_3rdPerson (1)`, 8.32 m behind,
 * 2.32 m above and 7.3° down in ship-root space — its own numbers, not the
 * HoverJet's, the same way its steering rates are its own. A parking space, not
 * the camera: see `JUMPSEAT_THIRD_PERSON_CHASE`.
 */
export const JUMPSEAT_THIRD_PERSON: ShipCamera = shipCameraFromSheet(JUMPSEAT.camera.thirdPerson)

/**
 * What the JumpSeat's third-person camera actually does. DEV-156.
 *
 * The same four components as the HoverJet's and none of the same numbers, and
 * two of the differences are structural rather than tuning:
 *
 *   - the chased target is **7.005 m**, INSIDE the 8.64 m parking space — the
 *     opposite direction from the HoverJet, whose target is further out;
 *   - the aim point is 4.64 m AHEAD of the ship rather than at it, so the
 *     JumpSeat's camera leads;
 *   - `upTarget` is null, so the up vector is world up rather than a point on
 *     the ship;
 *   - `positionMaxSpeed` 100 against a 0.1 s smoothTime is a **10 m** clamp on
 *     the trail, and it BINDS at flying speed. 2016's own `maxLagMetres`, on
 *     one vehicle only; the HoverJet's 45.9 m never binds.
 *
 * And `speed: 35` is a real smoothing where the HoverJet's 225 is pinned at an
 * instant Slerp — so this is also the one place 2016's frame-rate dependence is
 * visible, and it is ported rather than corrected (`render/classic-chase.ts`).
 */
export const JUMPSEAT_THIRD_PERSON_CHASE: ShipChase = shipChaseFromSheet(
  JUMPSEAT.camera.thirdPersonChase,
)
