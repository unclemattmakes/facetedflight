// src/sim/jumpseat.ts — the JumpSeat flight model. A LANDER, not a jet.
//
// The HoverJet is a 4 kg arrow with gravity switched off and 437.5 N up its
// tailpipe along body +Z. The JumpSeat is the opposite machine on every axis
// that matters: **15 kg, gravity ALWAYS ON, and its 750 N points along body
// +Y.** You do not fly it forward; you hold it up and lean. Let go of the
// throttle and it falls at 48.8 m/s.
//
// `docs/research/_jumpseat-spec.md` is the full trace. This header is the part
// you have to have in your head to read the code.
//
// ── The one orientation-shaped fact ───────────────────────────────────────
//
// `Thruster.thrustDirection` is **(0, 1, 0)** on the shipped prefab
// (`JumpSeat_Photon.prefab:8669`), against the C# initialiser's (0, 0, 1).
// That is hard rule 2 with teeth: copy the initialiser and you get a vehicle
// that flies forward instead of up, passes every "does it accelerate" test, and
// is wrong in the only way anyone would notice. The thrust vector is built in
// BODY space and rotated by the body orientation, exactly as `hoverjet.ts` does
// for its (0, 0, thrust) — the difference is the axis, and only the axis.
//
// ── What the JumpSeat does NOT have ───────────────────────────────────────
//
// No speed chain, no `EnergySystem_Ship`, no `maxSpeed` (`thrustForce` is a
// FORCE, not a speed ceiling), **no anisotropic body-space velocity bleed** —
// the HoverJet's signature 4.5 % / 6.5 % is a `Ship_HoverShip` field and this
// prefab has no `Ship_HoverShip` — no airbrake (`Input_Manager.cs:234-244`
// reads the brake button into empty `if` bodies), no free boost, and no
// centre-of-mass override (`VehiclePhysicsSettings.cs:12` is commented out).
// Its only velocity shaping is isotropic Unity linear drag, in two states.
// That is why the two vehicles cannot share a step function.
//
// ── The component stack, in the order this file runs it ───────────────────
//
// Root GameObject `&177722` of `Resources/JumpSeat_Photon.prefab` (guid
// `64d1f5fbe80e75d47bbae0c403ade860`). `Level.cs:309` instantiates it BY NAME
// out of `Resources/`, so no scene `m_Modifications` can reach the instance and
// the prefab asset IS the shipped value. There is no `_unet`-style decoy for
// this vehicle.
//
//   1. `Input_Manager`        `&11411946`  enabled  -> sampled as JumpSeatInput
//   2. `DragHack`             `&11417794`  OFF      -> selects `body.drag`   §2.4
//   3. `FuelManager`          `&11453642`  enabled  -> burn, and the LATCH    §2.5
//   4. `Thruster`             `&11481156`  OFF      -> body +Y, Hermite ramp  §2.2
//   5. `ShipOrientationManager` `&11428778` enabled -> three body torques     §2.3
//   6. four `HingeJoint`s     `&5977626`+  always   -> sag, and the cushion   §5
//   7. (integrate)                                  -> gravity, ALWAYS       §3
//   8. `HoverMotor`           `&11433312`  OFF      -> impulse, and it OWNS 2 §2.1
//
// Not modelled here: `LandingGearManager` (see "the gear" below),
// `Rotator_Input` (art lean — `src/sim/art-lean.ts`, render-only),
// `ShipHUDManager`, `CamChanger`, the FX managers.
//
// ── Who switches the three OFF components on ──────────────────────────────
//
// `Thruster` and `HoverMotor` are `m_Enabled: 0` on the prefab and are switched
// on together by `Trigger_EnableJumpShip.Enable_JumpSeat()` — `triggerDelay`
// 3.5 s (`playerstart_jumpSeat.prefab:20136`) plus a 4-count, so **T+7.5 s**.
// That is `seat.live`, and it is load-bearing in both directions: enabled from
// frame zero the player flies away during the countdown; never enabled, the
// seat falls at 32 m/s² with no thrust and no hover and lands in the sea.
//
// **The JumpSeat never rides the launch elevator.** `LaunchElevator.StartLaunch()`
// has exactly three call sites, all in `Input_Ship*.cs`, and this prefab carries
// no `Input_Ship` of any kind (`JUMPSEAT.hasInputShip` is false in the sheet).
// The `spawn.launchKind` / `spawn.launch` / `spawn.enableGravityOnLaunch` fields
// in `content/levels/*_jumpSeat.json` describe a scene-baked, disconnected copy
// of the *HoverJet's* shaft rig — 2.7 km from where the JumpSeat spawns on
// `int_01`. Nothing in this file or its seam reads them. See `game/flight.ts`.
//
// `DragHack` is the third, and it is switched by nothing but the hover ray:
// `HoverMotor.cs:60-64` turns it OFF inside the band, `:83-91` turns it ON when
// the ray misses. Because the motor is itself off until T+7.5 s, **DragHack
// cannot be on before then either** — the seat falls the whole countdown at
// `drag = 1.1`, never 0.65.
//
// ── The gear: 15 kg, ALWAYS DEPLOYED, and simulated ───────────────────────
//
// Matt, 2026-09-12: *"jumpseat's legs: these were 'springy legs', so when the
// jumpseat was in the air - the legs would sag a bit. and they'd cushion the
// landings."* So they are real physics, they are always out, and `OQ-1` is
// answered from the direction that costs nothing: the chassis stays 15 kg,
// because the four legs are separate `Rigidbody`s on `HingeJoint`s and a
// jointed child's mass does not add to its parent's in Unity.
//
// The model is `src/sim/jumpseat-legs.ts` — four 1-DOF sprung hinges at the
// fixed step, every constant out of `JUMPSEAT.legs`. Read that file's header
// for the joint model, the spring's unit question (OQ-6) and what it trades.
// `seat.legs = null` turns them off, which is how the A/B landing test and the
// hover-equilibrium guard below get a seat with no gear.
//
// The argument that they never retract — which Matt's answer confirms rather
// than replaces, and which is still what keeps `mass` at 15:
//
//  - `LandingGearManager.cs:20-22` casts `new Ray(transform.position, -Vector3.up)`
//    with **no maxDistance and no layer mask**, so it uses `DefaultRaycastLayers`
//    — everything except layer 2. The whole JumpSeat is on layer **25**, which is
//    included.
//  - The ray starts at the ship-root origin, and `collider_body` `&144294` — a
//    BoxCollider, `enabled`, not a trigger, layer 25 — **contains that origin**.
//    Composed from the sheet: centre (0, 0.43, 0.65), half-extents
//    (0.5765, 0.7315, 1.7801), rotated 9.7517° about x. Transforming the origin
//    into the box's own frame gives (0, −0.534, −0.568) against those extents —
//    inside, with 0.198 m of clearance in local y. That is a distance, computed
//    in the box's frame, not a guess about where the box "looks like" it is.
//  - Unity 5.4 / PhysX report a hit at **distance 0** for a ray starting inside a
//    primitive collider. The switch that suppresses it,
//    `Physics.queriesStartInColliders`, did not exist until Unity 2017.2 and
//    defaults to `true` precisely to preserve this behaviour.
//  - So `hit.distance = 0 < landingGearActivationHeight` (2.25 on the prefab; the
//    C# says 5 — hard rule 2 again) takes the `if (!landingGearActivated)`
//    branch, `landingGearActivated` is already `1` on the prefab, and **nothing
//    runs, every tick, for the whole mission.** A self-consistent steady state,
//    not a coincidence.
//
// The alternative reading — PhysX skips the containing collider, the ray finds
// terrain, and the chassis oscillates 16 kg airborne / 15 kg landed — would move
// thrust accel from 50 to 46.875 m/s², net climb from 18 to 14.875, and the
// hover equilibrium from 0.4922 m to 0.3034 m. It is **one constant away**:
// `tuning.mass`, read once in `createJumpSeat()`. `tests/unit/jumpseat.test.ts`
// pins today's reading and names the alternative next to it. Matt's answer
// settles the behaviour it was asked about (the legs are always out, so the
// mass never swaps) without settling the PhysX question underneath it, which is
// why the argument above is kept rather than deleted.
//
// SIM LAYER: no three, no DOM, no wall clock, no randomness, no allocation in
// the hot path. Fixed dt only — nothing here ever sees a frame delta (D4).

import { JUMPSEAT } from '@/generated/constants.generated'
import { type Curve, evaluateCurve } from './art-lean'
import { FIXED_DT, GRAVITY } from './constants'
import type { HoverMotorSpec, HoverMotorState } from './hover-motor'
import { createHoverMotor, stepHoverMotor } from './hover-motor'
import {
  applyJumpBurst,
  createJump,
  type JumpSpec,
  type JumpState,
  type JumpTick,
  jumpSupported,
  stepJumpCharge,
} from './jumpseat-jump'
import type { JumpSeatLegSpec, JumpSeatLegs } from './jumpseat-legs'
import { createJumpSeatLegs, legFootWorld, stepJumpSeatLegs } from './jumpseat-legs'
import { rotateVec3 } from './math/quat'
import { clamp01 } from './math/scalar'
import { copy, scaleAdd, set, type Vec3, v3 } from './math/vec3'
import { clearAccumulators, createRigidBody, integrate, type RigidBody } from './rigidbody'
import type { ContactProbe } from './targets'
import type { HeightField } from './terrain/height-field'
import { type Sheet, type SheetScale, scaleSheet } from './variant'

/**
 * The JumpSeat's block of the generated sheet, as a SHAPE: 2016's own values
 * (`JUMPSEAT`) or a variant's view of them (`jumpSeatView`). DEV-380.
 */
export type JumpSeatSheet = Sheet<typeof JUMPSEAT>

/**
 * 2016's JumpSeat with a variant's multipliers applied. An empty scale is the
 * sheet itself. See `hoverJetView`, which is this for the other aircraft.
 */
export const jumpSeatView = (scale: SheetScale): JumpSeatSheet =>
  scaleSheet<JumpSeatSheet>(JUMPSEAT, scale)

/**
 * A variant's MECHANICS: numbers for a behaviour 2016's prefab never had, so
 * there is no sheet key to scale (AIRCRAFT-VARIANTS §2.2). They arrive from
 * `content/aircraft/jumpseat.json` through `content/aircraft-schema.ts`'s
 * validator, which refuses a mechanic this interface does not name. Empty is
 * 2016, and every field is optional so that an absent one IS 2016's behaviour
 * rather than a default typed here.
 */
export interface JumpSeatMechanics {
  /**
   * DEV-384, overclocked's *"falls faster"*: a dimensionless multiplier on the
   * WORLD's gravity, for this seat alone. The world stays (0, −32, 0) — every
   * other body, the HoverJet's racer grid and the props all still read
   * `GRAVITY` — and the seat is handed its own scaled copy, built once, in
   * `createJumpSeat`. Absent, the seat's gravity IS `GRAVITY`, the same object.
   *
   * Gravity rather than drag because a fall is felt at its START: lower
   * free-fall drag only raises the terminal, which a seat reaches seconds
   * later (§3.2, open call 7). A variant that scales this should scale
   * `hoverMotor.hoverForce` by the same factor, or the cushion sinks:
   * `hoverEquilibriumHeight` below, and `tests/unit/variant-overclocked.test.ts`
   * holds every such variant at 2016's 0.4922 m.
   */
  readonly gravityScale?: number
  /**
   * DEV-383, the jumping spider: charge on a surface with both triggers,
   * release to launch along the seat's own up. `sim/jumpseat-jump.ts` is the
   * mechanic and its header is the rule. Absent, the seat has no jump and its
   * both-triggers gesture is 2016's boost; present, that gesture is the charge
   * and the seat has no boost.
   */
  readonly jump?: JumpSpec
}

/** 2016's seat: no mechanic. Frozen, shared, and only ever read. */
const NO_MECHANICS: JumpSeatMechanics = Object.freeze({})

/**
 * The seat's OWN gravity (DEV-384): the world's, scaled by the variant's
 * `gravityScale`. Returns `GRAVITY` itself when there is no scale, so a
 * `standard` seat integrates against the very vector it always did. Built once
 * per seat and frozen — never module-level scratch (trap 19): two seats of two
 * variants fly side by side in one world.
 */
const seatGravity = (mechanics: JumpSeatMechanics): Readonly<Vec3> => {
  const scale = mechanics.gravityScale
  if (scale === undefined) return GRAVITY
  return Object.freeze(v3(GRAVITY.x * scale, GRAVITY.y * scale, GRAVITY.z * scale))
}

/**
 * The two thresholds that are CALL-SITE LITERALS in 2016, not serialised fields.
 *
 * Hard rule 3 says a numeric literal under `src/sim/` needs explicit
 * justification. Here it is: neither of these is a `public` field, a
 * `[SerializeField]`, or anything else with a prefab row — they are constants
 * written into an expression, so there is no scene → prefab → `m_Modifications`
 * chain to trace and the extractor has nothing to read. They are `trust:
 * "code-default"` in the sheet's vocabulary, and they are exposed as tuning
 * fields so a test can vary them and so the day the extractor learns to emit
 * code-default literals this becomes a one-line change.
 *
 * `BOOST_DEADZONE` — `Thruster.cs:72` and `:81`, `if (inputManager.boostVal >
 * 0.05)`. Note the discontinuity it creates: at a raw boost of 0.05+ the
 * multiplier is `1.65 × 0.05 = 0.0825`, so **crossing the boost deadzone
 * momentarily cuts thrust to 8 %**. That is in the shipped math.
 * `Input_Manager.cs:220-231` zeroes anything under 0.1, which makes the
 * reachable band [0.165, 1.65] and the dip real but shallow in practice.
 *
 * `DRAG_HACK_GAS_THRESHOLD` — `DragHack.cs:19` and `:23`, `gasVal < 0.03`.
 */
const BOOST_DEADZONE = 0.05
const DRAG_HACK_GAS_THRESHOLD = 0.03

/**
 * Everything the flight model reads. Sourced from the generated constants sheet
 * by `createJumpSeat()` — never hand-typed. See `src/sim/constants.ts` and
 * CLAUDE.md hard rules 2 and 3.
 */
export interface JumpSeatTuning {
  /**
   * kg. `JUMPSEAT.rigidbody.mass` = 15. THE constant that OQ-1 would flip to 16;
   * see the landing-gear note in the header.
   */
  readonly mass: number
  /** Unity linear drag on the ground and under power. Shipped: 1.1. */
  readonly dragBase: number
  /**
   * Unity linear drag coasting in free air. Shipped: **0.65** — and the C#
   * initialiser says `0.3f` (`DragHack.cs:9`), which is a textbook hard-rule-2
   * instance. 41 % less drag falling than climbing is the JumpSeat's whole
   * "let go and drop" feel: terminal descent goes 28.70 m/s -> 48.84 m/s.
   */
  readonly dragFreefall: number
  /** Shipped: 1.75. */
  readonly angularDrag: number
  /** Newtons along body **+Y** at full throttle, full curve. Shipped: 750. */
  readonly thrustForce: number
  /** Analog boost multiplier. Shipped: 1.65 (the prefab; the residue says 1.25). */
  readonly boostMultiplier: number
  /** Seconds the accel curve ramps over. Shipped: 1.2. */
  readonly accelTime: number
  /** `accelCurve`: 3-key Unity `AnimationCurve`, 55 % of thrust in the first 20 %. */
  readonly accelCurve: Curve
  /** Angular rates, in Unity's loose units. Shipped: 0.8 / 1.45 / 1.1. */
  readonly rollRate: number
  readonly pitchRate: number
  readonly yawRate: number
  /** Tank size. Shipped: 100. */
  readonly maxFuel: number
  /** Units per second at any throttle above zero. Shipped: 1.9. */
  readonly burnRate: number
  /** Multiplier while ANY boost is held. Shipped: 2.35. */
  readonly boostBurnRateMultiplier: number
  /** `Thruster.cs:72` — see `BOOST_DEADZONE`. */
  readonly boostDeadzone: number
  /** `DragHack.cs:19` — see `DRAG_HACK_GAS_THRESHOLD`. */
  readonly dragHackGasThreshold: number
}

/**
 * Pilot intent for one tick.
 *
 * Sign convention is **deliberately identical to `HoverJetInput`'s** so
 * `src/input/` works for both vehicles unchanged: the port's world is Unity's
 * mirrored in z, that mirror is a conjugation which negates a quaternion's x
 * and y, and `hoverjet.ts:205-210` absorbs the whole of it into the meaning of
 * these fields and applies `(pitch·pitchRate, yaw·yawRate, roll·rollRate)` with
 * no negation. This does the same. Two vehicles that disagree about which way
 * the stick goes IS the bug — see "The orientation lesson" in DEVIATIONS.md.
 */
export interface JumpSeatInput {
  /** `gasVal`, 0 … 1. Multiplies the thrust OUTPUT, not the ramp. */
  throttle: number
  /**
   * `inputManager.boostVal`, 0 … 1 — **analog**, unlike the HoverJet's boolean.
   * `Input_Manager.cs:220-231` sets it from the left trigger only while the
   * right trigger is also held, and zeroes anything below 0.1.
   */
  boost: number
  /** Right-hand-positive roll. */
  roll: number
  pitch: number
  yaw: number
}

export const noJumpSeatInput = (): JumpSeatInput => ({
  throttle: 0,
  boost: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
})

export interface JumpSeat {
  body: RigidBody
  readonly tuning: JumpSeatTuning
  /**
   * The gravity this seat integrates against, m/s². The world's `GRAVITY`
   * itself on every seat but a variant with a `gravityScale` (DEV-384), which
   * gets its own frozen, scaled copy. Everything that asks what THIS seat
   * weighs — the integrator, the legs, `hoverEquilibriumHeight`, the
   * autopilot's feed-forward — reads it here, never `GRAVITY`:
   * `tests/unit/variant-sheet-reads.test.ts` sweeps the seat's modules for a
   * direct read.
   */
  readonly gravity: Readonly<Vec3>
  /** `hoverForce` 6.9 / `hoverHeight` 6.25 — the JumpSeat's own, not the jet's. */
  readonly hoverSpec: HoverMotorSpec
  /** `motorActivated` and the last ray distance. Owned by `stepHoverMotor`. */
  readonly hover: HoverMotorState
  /**
   * The four sprung legs, or `null` for a seat with no gear.
   *
   * Always present on a `createJumpSeat()` — the prefab ships the gear deployed
   * and `LandingGearManager` never retracts it. `null` exists so a test can
   * measure the SAME landing with and without them, which is the only way to
   * say what the cushion is worth, and so the hover-equilibrium guard can still
   * see the 0.4922 m a seat with nothing under it settles at.
   */
  legs: JumpSeatLegs | null
  /**
   * `Trigger_EnableJumpShip.Enable_JumpSeat()` has fired: `Thruster` and
   * `HoverMotor` are enabled. False for the first 7.5 s of every mission, during
   * which the seat has gravity and torque and nothing else.
   */
  live: boolean
  /**
   * `ShipOrientationManager.m_Enabled`, which is **1 on the prefab** — so the
   * seat can be rotated from the instant it spawns, before the thruster exists.
   * The spec's §1.2 sketch put torque behind the same gate as thrust; the
   * sheet's `JUMPSEAT.orientation.componentEnabled` says otherwise and the sheet
   * wins. Kept as its own flag rather than folded into `live` so that changing
   * the answer is one assignment and one test.
   */
  steerable: boolean
  /**
   * `FuelManager.shouldUpdateFuel`. False in Free Flight. In 2016 that was keyed
   * on a `PlayerPrefs` string that `Level.ForceGameMode` never wrote (so the
   * forced-Free-Flight mission `int_02_jumpSeat` still burned); the port keys it
   * on the mode actually selected, which is a deviation and an improvement.
   */
  burnsFuel: boolean
  /**
   * `Thruster.currentTime`. Advances by exactly `dt` per tick and **ONLY while
   * the throttle is open**, and is reset to 0 the moment it closes
   * (`Thruster.cs:68`) — so the 1.2 s ramp restarts from scratch on every
   * release. This is an integrator, not a rate limiter, and that distinction is
   * the whole difference in feel.
   */
  curveTime: number
  /**
   * `Thruster.adjustedThrustForce`. Once `curveTime >= accelTime` the `if` stops
   * running and this **freezes** at its last computed value — the curve
   * evaluated just under 1, i.e. within float noise of `thrustForce`. It never
   * lands on exactly 750.
   */
  adjustedThrustForce: number
  /**
   * `FuelManager.currentFuel`. Starts at `maxFuel` (the prefab's serialised 0 is
   * overwritten in `Start()` — do not start at 0).
   *
   * **It is not clamped, and it goes negative.** `FuelManager.UpdateFuel()`
   * guards the burn on `gasVal > 0` and on nothing else, so holding the throttle
   * on a dead tank keeps digging. That is observable: a refuel pad gives 10
   * units/s, so a −50 tank costs five seconds of contact before the thruster
   * comes back at all. Verified against `FuelManager.cs:61-86` in this session,
   * beyond what the spec recorded.
   */
  fuel: number
  /**
   * `disableThisWhenEmpty.enabled`, and `disableThisWhenEmpty` resolves to
   * **the Thruster itself** (`fileID 11481156`). At zero fuel the component is
   * switched off, and with gravity on that is a fall, not a soft penalty. It is
   * LATCHED: only `addFuel()` turns it back on.
   */
  thrusterEnabled: boolean
  /**
   * `DragHack.enabled`. Owned by the HoverMotor's ray (step 7), read by the drag
   * select (step 2) on the FOLLOWING tick — see the note there.
   */
  dragHackEnabled: boolean
  /**
   * The thrust force actually applied this tick, newtons. An OUTPUT, kept so the
   * HUD and the tests can read what happened rather than recompute what they
   * believe should have happened.
   */
  appliedThrust: number
  /**
   * Where the four feet were last tick and are now, each with the leg
   * capsule's radius (DEV-120). What the pad plates are scored against: on the
   * shipped prefab the leg capsules are the ONLY enabled colliders tagged
   * `Player`, so in 2016 a plate fired when a foot touched it and never for the
   * body — see `ContactProbe` in `sim/targets.ts`. Refreshed by
   * `updateJumpSeatFootProbes()`, which the seam calls after the collision has
   * placed the body. Empty on a seat with no gear. PER SEAT, never module-level
   * (trap 19).
   */
  readonly footProbes: readonly ContactProbe[]
  /**
   * The jump (DEV-383), or `null` on every seat whose variant carries none —
   * which is how the standard and overclocked steps stay bit-identical: every
   * line `stepJumpSeat` adds for the spider is behind this being non-null.
   */
  readonly jump: JumpState | null
}

/** A probe the seat can write into. `ContactProbe` is the read side. */
interface FootProbe {
  readonly from: Vec3
  readonly to: Vec3
  readonly radius: number
  /** False until the first refresh, so the first sweep is a point, not a line from the origin. */
  primed: boolean
}

// Volatile module-level scratch. Valid only inside the one synchronous call
// that writes them — never stored, never read across calls.
//
// TRAP 19: `ai-racer.ts` shared ONE `HoverJetInput` across every racer, a
// finished racer inherited the other racer's stick, and it flew on frozen until
// it went into the sea. Invisible to every single-object test, because with one
// object there is nobody to inherit from. These are write-then-read-then-discard
// inside `stepJumpSeat` only, and `tests/unit/jumpseat.test.ts` steps a SECOND
// seat and asserts the first did not move for every stateful behaviour here.
const _thrustBody: Vec3 = v3()
const _thrustWorld: Vec3 = v3()
const _torqueBody: Vec3 = v3()
const _torqueWorld: Vec3 = v3()
/** What `stepJumpCharge` did this tick. Written and read inside `stepJumpSeat` only. */
const _jumpTick: JumpTick = { charging: false, burning: false, fired: false }

/** No terrain yet. Frozen, shared, and only ever read. */
const NO_FIELDS: readonly HeightField[] = Object.freeze([]) as readonly HeightField[]

/**
 * The `accelCurve` as `art-lean.ts`'s `Curve`.
 *
 * The extractor normalises `Rotator_Input`'s curves to `{ keys, preInfinity,
 * postInfinity }` but leaves `Thruster.accelCurve` in raw Unity YAML shape
 * (`m_Curve`), so this adapts the shape — it does not introduce a value. Every
 * number still comes from the sheet.
 *
 * `m_PreInfinity` / `m_PostInfinity` are 2 (ping-pong) but never apply: the
 * argument is clamped to [0, 1) by the `curveTime < accelTime` guard.
 *
 * HANDOVER: `tools/extract/constants.mjs` should normalise this curve the way it
 * already normalises the `artRotator` ones, and then this function deletes.
 */
const accelCurveFromSheet = (sheet: JumpSeatSheet): Curve => ({
  keys: sheet.thruster.accelCurve.m_Curve.map((k) => ({
    time: k.time,
    value: k.value,
    inSlope: k.inSlope,
    outSlope: k.outSlope,
  })),
})

/**
 * Build a JumpSeat from the generated constants sheet.
 *
 * This is the only place tuning values enter the sim, and every one of them is
 * read from the shipped `Resources/JumpSeat_Photon.prefab`.
 *
 * **The sheet is a PARAMETER, defaulting to itself** (DEV-380), exactly as
 * `createHoverJet`'s is: a variant hands in `jumpSeatView(scale)`, everything
 * else passes nothing and flies 2016. The old `Partial<JumpSeatTuning>` of
 * absolute overrides, which nothing passed, is gone.
 *
 * The gear is NOT read through it: `createJumpSeatLegs()` reads the legs'
 * geometry off the sheet itself, because a variant is the same airframe on
 * the same legs (AIRCRAFT-VARIANTS §6.2) and `rigidbody.mass`, the one number
 * the legs share with this block, is outside every variant's whitelist.
 * `tests/unit/variant-sheet-reads.test.ts` holds that reasoning to the source.
 *
 * `mechanics` is the variant's second half (DEV-384): what 2016 never had, so
 * nothing on the sheet to scale. Empty, the default, is 2016.
 */
export const createJumpSeat = (
  sheet: JumpSeatSheet = JUMPSEAT,
  mechanics: JumpSeatMechanics = NO_MECHANICS,
): JumpSeat => {
  const rb = sheet.rigidbody
  const thruster = sheet.thruster
  const orientation = sheet.orientation
  const fuel = sheet.fuel

  const tuning: JumpSeatTuning = {
    mass: rb.mass,
    dragBase: rb.drag,
    dragFreefall: sheet.dragHack.drag_freefall,
    angularDrag: rb.angularDrag,
    thrustForce: thruster.thrustForce,
    boostMultiplier: thruster.boostMultiplier,
    accelTime: thruster.accelTime,
    accelCurve: accelCurveFromSheet(sheet),
    rollRate: orientation.rollRate,
    pitchRate: orientation.pitchRate,
    yawRate: orientation.yawRate,
    maxFuel: fuel.maxFuel,
    burnRate: fuel.burnRate,
    boostBurnRateMultiplier: fuel.boostBurnRateMultiplier,
    boostDeadzone: BOOST_DEADZONE,
    dragHackGasThreshold: DRAG_HACK_GAS_THRESHOLD,
  }

  const legs = createJumpSeatLegs()
  return {
    body: createRigidBody({
      mass: tuning.mass,
      drag: tuning.dragBase,
      angularDrag: tuning.angularDrag,
      // ALWAYS true, unlike the HoverJet's. `m_UseGravity: 1` on the prefab and
      // there is no live writer: `PlayerShipInitialization.SystemComponents` is
      // `[{fileID: 0}, {fileID: 0}]` — two nulls — where the HoverJet's carries
      // `Ship_HoverShip` and `EnergySystem_Ship`, and `EnergySystem_Ship.cs:99`
      // is the project's ONLY live `useGravity = false`. The JumpSeat is a
      // lander because nothing was ever wired up to make it anything else.
      useGravity: rb.useGravity,
    }),
    tuning,
    gravity: seatGravity(mechanics),
    hoverSpec: {
      hoverForce: sheet.hoverMotor.hoverForce,
      hoverHeight: sheet.hoverMotor.hoverHeight,
    },
    hover: createHoverMotor(),
    legs,
    live: false,
    steerable: orientation.componentEnabled,
    burnsFuel: true,
    curveTime: 0,
    adjustedThrustForce: 0,
    fuel: fuel.maxFuel,
    thrusterEnabled: true,
    dragHackEnabled: false,
    appliedThrust: 0,
    footProbes: footProbesFor(legs),
    jump: mechanics.jump ? createJump(mechanics.jump) : null,
  }
}

/** One probe per leg, at the capsule's own radius. Nothing for a seat with no gear. */
const footProbesFor = (legs: JumpSeatLegs | null): FootProbe[] =>
  legs
    ? legs.specs.map((spec) => ({
        from: v3(),
        to: v3(),
        radius: spec.contactRadius,
        primed: false,
      }))
    : []

/**
 * Roll the feet forward one tick: last tick's `to` becomes `from`, and `to` is
 * where each foot is NOW — the capsule's bottom cap, `legFootWorld`, from the
 * body's current pose and the leg's current hinge angle.
 *
 * Call it AFTER the terrain collision has placed the body and BEFORE the
 * mission scores, so the sweep runs from where a foot was to where it ended up
 * this tick rather than to where it was about to be pushed out of the floor. On
 * the first call each probe's `from` is set equal to `to`, which
 * `sweepHitsBox` treats as a containment test.
 */
export const updateJumpSeatFootProbes = (seat: JumpSeat): void => {
  const legs = seat.legs
  if (!legs) return
  const probes = seat.footProbes as readonly FootProbe[]
  for (let i = 0; i < probes.length; i++) {
    const probe = probes[i] as FootProbe
    const spec = legs.specs[i] as JumpSeatLegSpec
    const angle = legs.legs[i]?.angle ?? 0
    if (probe.primed) copy(probe.from, probe.to)
    legFootWorld(probe.to, spec, angle, seat.body)
    if (!probe.primed) {
      copy(probe.from, probe.to)
      probe.primed = true
    }
  }
}

/** Forget the sweep history — after a respawn, so a foot does not score a line across the map. */
export const resetJumpSeatFootProbes = (seat: JumpSeat): void => {
  for (const probe of seat.footProbes as readonly FootProbe[]) probe.primed = false
}

/**
 * `FuelManager.AddFuel()` — the only way back from an empty tank.
 *
 * Every jump pad is also a refuel pad: `target_jumppad.prefab` carries one
 * `Trigger_Refuel` at `refuelRate: 10`/s on a sphere collider, layer 2, which is
 * excluded from the HoverMotor's mask so a pad is transparent to the hover ray.
 * Empty to full is 10 s of contact.
 *
 * 2016 re-enables the Thruster unconditionally here — including on a tank that
 * is still negative, in which case the next tick's empty check switches it
 * straight back off. Reproduced, because the fuel deficit is the thing the
 * player is paying off and hiding it would make a pad look broken.
 */
export const addFuel = (seat: JumpSeat, amount: number): void => {
  seat.fuel += amount
  seat.thrusterEnabled = true
}

/**
 * Advance one JumpSeat by exactly one fixed tick.
 *
 * The order is the one in the header and it is load-bearing. Two places in
 * particular:
 *
 *  - **Fuel burns BEFORE thrust**, so the tick that empties the tank produces no
 *    force. In 2016 these were on different clocks (`FuelManager` in `Update`,
 *    `Thruster` in `FixedUpdate`) and the order was script-execution-order
 *    dependent; one tick either way, and this is the one that cannot produce
 *    thrust the tank could not pay for.
 *  - **The hover motor runs AFTER `integrate`**, matching `stepHoverMotor`'s
 *    existing contract ("called AFTER the flight model has moved the body and
 *    BEFORE terrain collision"). Because the hover force is an IMPULSE — a
 *    direct velocity edit, NOT divided by dt — the ordering costs one tick of
 *    lag and not a different equilibrium.
 */
export const stepJumpSeat = (
  seat: JumpSeat,
  input: JumpSeatInput,
  fields: readonly HeightField[] = NO_FIELDS,
  dt: number = FIXED_DT,
): void => {
  const { body, tuning } = seat

  clearAccumulators(body)

  const gas = clamp01(input.throttle)
  const rawBoost = clamp01(input.boost)
  // ── 1b. The jump's charge (DEV-383) ─────────────────────────────────────
  //
  // Only on a seat that carries one; `sim/jumpseat-jump.ts` is the rule. On
  // such a seat the both-triggers gesture is the CHARGE, not a boost, so the
  // thruster below is handed a multiplier of 1 and the burn the plain rate
  // whenever it is not charging, and while it IS charging the thrust is
  // suppressed and the tank pays the boosted rate until the charge is full.
  // Read BEFORE the burn so a tank that empties on this tick still charged on
  // it, and the latch it sets is what the next tick's release sees.
  const jump = seat.jump
  const jumpTick = jump
    ? stepJumpCharge(
        jump,
        gas > 0 && rawBoost > 0,
        seat.live && seat.thrusterEnabled,
        jumpSupported(seat.legs, seat.hover, seat.hoverSpec),
        dt,
        _jumpTick,
      )
    : null
  const charging = jumpTick?.charging === true
  // `Thruster.cs:72-95`. Analog above the deadzone, hard 1 below it — which is
  // the 8 % thrust dip on the way through. Not a latch across ticks here because
  // input is sampled once per tick, which is what 2016's `Update` amounted to.
  // A seat with a jump has no boost: the gesture belongs to the charge.
  const boost = jump ? 1 : rawBoost > tuning.boostDeadzone ? tuning.boostMultiplier * rawBoost : 1
  // The throttle the THRUSTER sees: shut while charging, so the seat settles
  // onto its gear and the ramp restarts on the release, as it does on any
  // release of the throttle (`Thruster.cs:68`).
  const thrustGas = charging ? 0 : gas

  // ── 2. DragHack: which of the two drags is in force this tick ───────────
  //
  // `DragHack.cs:18-27`, and note the second condition is `_rigidbody.drag <=
  // drag_freefall` rather than a plain else: at 1.1 it is false and the line is
  // a no-op, at 0.65 it is true and the base drag comes back. Written out the
  // same way so the hysteresis reads as hysteresis.
  //
  // `dragHackEnabled` is whatever the hover ray left behind at the END of the
  // previous tick. In 2016 `DragHack` ran in `Update()` at frame rate and the
  // motor in `FixedUpdate()`, so the lag was somewhere between zero and several
  // ticks depending on the machine; one fixed tick is the honest fixed-step
  // reading of that.
  if (seat.dragHackEnabled) {
    if (gas < tuning.dragHackGasThreshold) body.drag = tuning.dragFreefall
    else if (body.drag <= tuning.dragFreefall) body.drag = tuning.dragBase
  }

  // ── 3. Fuel ────────────────────────────────────────────────────────────
  //
  // `FuelManager.cs:61-86`. Note the two disagreements with the Thruster, both
  // shipped: the burn is BINARY in boost (any `boostVal > 0` costs the full
  // 2.35x) while thrust is only boosted above 0.05, and the tank is never
  // clamped at zero.
  if (seat.burnsFuel) {
    if (jumpTick !== null) {
      // The spider (DEV-383, AIRCRAFT-VARIANTS §4.3): the charge pays its own
      // boosted rate and stops paying at full; the jet pays the plain rate.
      if (jumpTick.burning) seat.fuel -= tuning.burnRate * tuning.boostBurnRateMultiplier * dt
      else if (!charging && gas > 0) seat.fuel -= tuning.burnRate * dt
    } else if (gas > 0) {
      seat.fuel -= tuning.burnRate * (rawBoost > 0 ? tuning.boostBurnRateMultiplier : 1) * dt
    }
    // Re-asserted every tick while the tank is empty, exactly as 2016 does —
    // which is why `addFuel()` on a still-negative tank buys one tick.
    if (seat.fuel <= 0) seat.thrusterEnabled = false
  }

  // ── 4. Thruster — body +Y, through the accel curve ─────────────────────
  //
  // `Thruster.cs:102-147`. `FixedUpdate` calls `UpdateThrust` only while the
  // throttle is open; `Update` resets `currentTime` the moment it closes.
  if (thrustGas <= 0) seat.curveTime = 0
  seat.appliedThrust = 0
  if (seat.live && seat.thrusterEnabled && thrustGas > 0) {
    if (seat.curveTime < tuning.accelTime) {
      // `Evaluate(0)` is 0, so the FIRST tick of a burn applies no force at all.
      seat.adjustedThrustForce =
        evaluateCurve(tuning.accelCurve, seat.curveTime / tuning.accelTime) * tuning.thrustForce
      seat.curveTime += dt
    }
    // `useCurve` is 1 on the prefab, so this is the curve branch. The gas
    // multiplies the OUTPUT: half throttle is half force at every point on the
    // same 1.2 s curve, not a slower ramp.
    seat.appliedThrust = seat.adjustedThrustForce * thrustGas * boost
    // `AddRelativeForce` — BODY space — and `ForceMode.Force` (Unity's default),
    // so this one IS divided by mass and multiplied by dt inside `integrate`.
    set(_thrustBody, 0, seat.appliedThrust, 0)
    rotateVec3(_thrustWorld, body.orientation, _thrustBody)
    scaleAdd(body.force, body.force, _thrustWorld, 1)
  }

  // ── 5. ShipOrientationManager — three body torques ─────────────────────
  //
  // `ShipOrientationManager.cs:27-41`. 2016 multiplies each rate by `mass` and
  // by `transform.localScale.x` precisely because Unity's inertia tensor is
  // mass-proportional, which makes the result mass-independent.
  // `rigidbody.ts:84-88` models inertia as a scalar 1, so both factors are
  // dropped and the rates are used raw as angular-acceleration coefficients —
  // exactly as `hoverjet.ts:205-212` does, which keeps both vehicles on one
  // convention. (`localScale` is 1 here in any case.) It does NOT make the two
  // vehicles' rate numbers physically comparable; a fitted inertia tensor is
  // what PORT_PLAN §3 M1.5 exists to produce.
  if (seat.steerable) {
    set(
      _torqueBody,
      input.pitch * tuning.pitchRate,
      input.yaw * tuning.yawRate,
      input.roll * tuning.rollRate,
    )
    rotateVec3(_torqueWorld, body.orientation, _torqueBody)
    scaleAdd(body.torque, body.torque, _torqueWorld, 1)
  }

  // ── 6. The landing gear — four sprung hinges ───────────────────────────
  //
  // `src/sim/jumpseat-legs.ts`. It runs HERE, after the thrust and the torque
  // and before `integrate`, for two reasons that are both about one tick:
  //
  //  - the legs read the chassis's acceleration from its VELOCITY across the
  //    previous tick, so they see the hover impulse and the terrain collision
  //    — neither of which is a force, and both of which are exactly what a
  //    landing gear exists for;
  //  - what they are holding the seat up with goes into the SAME accumulator
  //    the thruster used, so the cushion lands on the tick of the impact
  //    rather than the tick after it.
  //
  // Unlike the Thruster and the HoverMotor there is no `live` gate: the legs
  // are physics, not a component someone switches on, and they hang off the
  // chassis from the instant it spawns.
  if (seat.legs) stepJumpSeatLegs(seat.legs, body, fields, dt, seat.gravity)

  // ── 7. Integrate ───────────────────────────────────────────────────────
  // Gravity is (0, -32, 0) and it is ALWAYS on. This is the line that makes the
  // JumpSeat a different machine. `seat.gravity` IS that vector, unless the
  // variant scales it (DEV-384) — and then the legs above feel the same one.
  integrate(body, seat.gravity, dt)

  // ── 8. HoverMotor — impulse, and it owns the DragHack switch ───────────
  //
  // Disabled until GO, and `DragHack` is disabled with it: `HoverMotor.Awake()`
  // still runs on a disabled component, so its `drag_starting` capture sees 1.1,
  // but nothing can flip the hack until the motor's first `FixedUpdate`.
  if (!seat.live) {
    seat.dragHackEnabled = false
    body.drag = tuning.dragBase
    return
  }

  stepHoverMotor(seat.hover, body, fields, seat.hoverSpec)

  // ── 8b. The jump's burst (DEV-383) ─────────────────────────────────────
  //
  // Beside the hover motor, and for its reason: both are direct velocity
  // edits after `integrate`, the motor's "NOT divided by dt" impulse being the
  // precedent. Along the body's own +Y, so a lean aims the jump.
  if (jump) applyJumpBurst(jump, body)

  // `HoverMotor.cs:60-64` and `:83-91`, as THREE cases rather than two. The
  // middle one is the hysteresis band and a two-state port gets it wrong: the
  // "turn it off" branch is nested inside `hit.distance <= hoverHeight`, while
  // the ray itself reaches `2 * hoverHeight`.
  if (seat.hover.distance <= seat.hoverSpec.hoverHeight) {
    // Inside the band: the hack is forced off AND the base drag is restored, in
    // the same breath, by the motor rather than by `DragHack`.
    seat.dragHackEnabled = false
    body.drag = tuning.dragBase
  } else if (!seat.hover.active) {
    // The ray missed entirely. Next tick's drag select gets to choose.
    seat.dragHackEnabled = true
  }
  // else: hit between hoverHeight and 2 * hoverHeight — unchanged, deliberately.
}

/**
 * The hover equilibrium height, metres above the surface, for a given seat.
 *
 * Derived, not measured, and therefore held to the DEV-027 standard: this is the
 * **distance along the body's own −up between the ship-root origin and the
 * surface** at which the hover impulse exactly cancels one tick of gravity, with
 * the body perfectly stationary.
 *
 *     p² · hoverForce / m = |g| · dt        (impulse, so dt does NOT divide it)
 *     d = hoverHeight · (1 − sqrt(|g| · dt · m / hoverForce))
 *
 * Drag does not appear, and that is not an omission: at the fixed point the
 * velocity at the moment `integrate` applies drag is exactly zero, so the drag
 * factor multiplies nothing. The seat hangs there without hunting.
 *
 * 6.25 · (1 − sqrt(32 · 0.0121999998 · 15 / 6.9)) = **0.49221 m**, which is what
 * `DERIVED.jumpseat.hoverEquilibriumHeight` carries to four places. At the
 * landing-gear-retracted mass of 16 it would be 0.3034 m — the two are 0.19 m
 * apart, which is why the measured test in `tests/unit/jumpseat.test.ts`
 * discriminates between them rather than merely agreeing with one.
 *
 * **A seat with its legs on never reaches it.** The feet hang 1.3 m below the
 * ship-root origin, so they touch a long way above 0.49 m and the seat parks on
 * its gear with the hover motor carrying most of the weight — measured in
 * `tests/unit/jumpseat-legs.test.ts`. This number is the height a seat with
 * NOTHING under it settles at, and it is still the number the model has to
 * agree with when the legs are off.
 *
 * `|g|` is the SEAT's (DEV-384): a variant that scales gravity and
 * `hoverForce` by one factor leaves the ratio, and so this height, 2016's.
 */
export const hoverEquilibriumHeight = (seat: JumpSeat, dt: number = FIXED_DT): number => {
  const g = Math.abs(seat.gravity.y)
  const { hoverForce, hoverHeight } = seat.hoverSpec
  return hoverHeight * (1 - Math.sqrt((g * dt * seat.body.mass) / hoverForce))
}

/**
 * `Trigger_EnableJumpShip`'s countdown, which is what a JumpSeat mission has
 * instead of an elevator ride.
 *
 * `Trigger_EnableJumpShip.cs:17-46`: crossing the trigger on the spawn rig
 * disables the trigger's own collider (so it cannot re-fire) and starts
 * `Countdown_JumpSeat(4)`, which waits `triggerDelay` and then counts four
 * one-second beats before calling `Enable_JumpSeat()`. The ship spawns inside
 * that trigger, so T = 0 is scene load.
 */
export interface JumpSeatStartSpec {
  /** `triggerDelay`, `playerstart_jumpSeat.prefab:20136`. Shipped: 3.5 s. */
  readonly triggerDelaySeconds: number
  /**
   * The four `WaitForSeconds(1)` beats. The `4` is a call-site literal at
   * `Trigger_EnableJumpShip.cs:37` — `trust: "code-default"`, no prefab row.
   */
  readonly countdownSeconds: number
}

export interface JumpSeatStart {
  /** Seconds since the trigger fired. */
  elapsed: number
  /** True once `Enable_JumpSeat()` has run. Mirrors `JumpSeat.live`. */
  live: boolean
}

export const createJumpSeatStart = (): JumpSeatStart => ({ elapsed: 0, live: false })

/** Total wait from scene load to thrust, seconds. Shipped: 3.5 + 4 = 7.5. */
export const startTotalSeconds = (spec: JumpSeatStartSpec): number =>
  spec.triggerDelaySeconds + spec.countdownSeconds

/**
 * Advance the countdown one fixed tick. Returns true on the single tick
 * `Enable_JumpSeat()` fires, so a caller can play the "GO" cue exactly once.
 *
 * The seat still integrates during all of this — it has gravity and torque and
 * no thrust and no hover, so **it falls from the instant the scene loads**.
 * Whether that is a drop or a sit depends on what is under the respawn marker,
 * which is spec OQ-5 and a question for the mission layer, not for this file.
 */
export const stepJumpSeatStart = (
  start: JumpSeatStart,
  spec: JumpSeatStartSpec,
  dt: number = FIXED_DT,
): boolean => {
  if (start.live) return false
  start.elapsed += dt
  if (start.elapsed < startTotalSeconds(spec)) return false
  start.live = true
  return true
}
