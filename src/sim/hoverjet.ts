// src/sim/hoverjet.ts — the HoverJet flight model.
//
// This is the file the whole port exists to get right. Terrain can be
// regenerated, art can be remodelled, levels are data — but the *feel* of a
// 4 kg body with 437.5 N up its tailpipe was hand-tuned over two years and
// cannot be re-derived from anything except the shipped prefab.
//
// ── The signature mechanic ────────────────────────────────────────────────
// Every tick the ship deletes a fixed FRACTION of its sideways and vertical
// velocity *measured in body space*, while forward velocity is left to plain
// Unity drag. Body-X loses 4.5 % per tick and body-Y loses 6.5 %, against
// forward's 1.464 %. Continuously that is 4.98 /s and 6.72 /s against 1.21 /s
// — a 4.12 : 1 anisotropy, which is the entire "arcade jet on rails" quality:
// the ship goes where it points, banks bite immediately, and drifting sideways
// feels like the air itself is thick.
//
// Reproducing that ratio matters more than matching any single force number.
//
// ── Why there is no physics engine ───────────────────────────────────────
// That bleed happens BETWEEN force accumulation and integration, on a vector
// expressed in the body frame. A rigid-body engine owns exactly that seam and
// gives you no clean way in; you end up fighting it every tick. With one
// dynamic body and heightfield ground contact there is nothing else an engine
// would have been buying us. PORT_PLAN §2.2 / DECISIONS D3.
//
// Ghost replays do NOT need bit-determinism — the 2016 ghosts were baked
// Animator clips, not physics replays (research 03 + _verify-v-modes) — so
// that argument for an engine is dead too.

import { HOVERJET } from '@/generated/constants.generated'
import { FIXED_DT, GRAVITY } from './constants'
import { rotateVec3, rotateVec3Inverse } from './math/quat'
import { scaleAdd, set, type Vec3, v3 } from './math/vec3'
import { clearAccumulators, createRigidBody, integrate, type RigidBody } from './rigidbody'
import type { SpeedProfileModel } from './route'
import {
  chainedMaxSpeed,
  createSpeedChain,
  type SpeedChainSpec,
  type SpeedChainState,
  stepSpeedChain,
  tickTerminalSpeed,
} from './speed-chain'
import { type Sheet, type SheetScale, scaleSheet } from './variant'

/**
 * The HoverJet's block of the generated sheet, as a SHAPE: 2016's own values
 * (`HOVERJET`) or a variant's view of them (`hoverJetView`). DEV-380.
 */
export type HoverJetSheet = Sheet<typeof HOVERJET>

/**
 * 2016's HoverJet with a variant's multipliers applied — `sim/variant.ts`'s
 * `scaleSheet` over this vehicle's block. An empty scale is the sheet itself.
 * The content layer decides which keys a variant may name
 * (`content/aircraft-schema.ts`); this only applies them.
 */
export const hoverJetView = (scale: SheetScale): HoverJetSheet =>
  scaleSheet<HoverJetSheet>(HOVERJET, scale)

/**
 * Where a HoverJet built from `sheet` settles, aligned and unboosted, m/s —
 * for `thrust` newtons, which defaults to the sheet's own `ship.maxSpeed` (the
 * unchained cruise). DEV-382.
 *
 * The racers' seed speed and the instructor's throttle ceiling read this off
 * the jet they are flying, so a variant's thrust and drag move both. They read
 * `derived.hoverjet.terminalSpeedCruise` before, which is 2016's speed whatever
 * the racer flies: a hidden standard (AIRCRAFT-VARIANTS §1.3). On 2016's sheet
 * this is that row unrounded, 89.81145851 against the sheet's 89.8115.
 */
export const cruiseSpeed = (sheet: HoverJetSheet, thrust: number = sheet.ship.maxSpeed): number =>
  tickTerminalSpeed(thrust, sheet.rigidbody.mass, sheet.rigidbody.drag)

/**
 * Where a HoverJet built from `sheet` settles at full throttle with boost held,
 * unchained, m/s: 179.6 on 2016's sheet (`derived.hoverjet.terminalSpeedBoost`,
 * unrounded), 323.3 on the speed jet. DEV-382 follow-up: the player
 * autopilot's velocity profile tops out here, and the racers' ring approach
 * envelope is 2016's.
 */
export const boostedCruiseSpeed = (sheet: HoverJetSheet): number =>
  cruiseSpeed(sheet, sheet.ship.maxSpeed * sheet.ship.boostMultiplier)

/**
 * What a velocity profile needs to know about a HoverJet built from `sheet`
 * (`sim/route.ts`'s `withSpeedProfile`), off the sheet itself. DEV-394.
 *
 * `brakePerMetre` is the fixed-step integrator's answer, not a fit: with no
 * thrust a tick multiplies the velocity by `1 − drag·dt` and then moves the
 * body `v·dt`, so the speed lost per metre is `drag / (1 − drag·dt)` at every
 * speed — 1.218 m/s per metre on 2016's sheet. `tests/unit/route.test.ts`
 * coasts a jet and holds it to that. The profile read this as 5.3 m/s² of
 * constant deceleration before, which a flight sheds in 125 m and the old
 * profile planned over 2.1 km.
 *
 * `latAccel` is the caller's: the lateral acceleration the ship holds in a
 * bend, which this flight model does not reduce to one number on the sheet.
 */
export const speedProfileModel = (sheet: HoverJetSheet, latAccel: number): SpeedProfileModel => {
  const drag = sheet.rigidbody.drag
  return {
    latAccel,
    brakePerMetre: drag / (1 - drag * FIXED_DT),
    thrustAccel: (sheet.ship.maxSpeed * sheet.ship.boostMultiplier) / sheet.rigidbody.mass,
    drag,
    topSpeed: boostedCruiseSpeed(sheet),
  }
}

/**
 * Everything the flight model reads. Sourced from the generated constants
 * sheet by `createHoverJet()` — never hand-typed. A literal here is a bug;
 * see `src/sim/constants.ts` and CLAUDE.md hard rule 2.
 */
export interface HoverJetTuning {
  /** Newtons along body +Z at full throttle. Shipped: 437.5. */
  readonly maxSpeed: number
  /** Thrust multiplier while boosting. Shipped: 2. */
  readonly boostMultiplier: number
  /**
   * Throttle spool rate, units/second. Shipped: 4, i.e. 0.25 s from idle to
   * full. This is what stops the HoverJet feeling like a light switch.
   */
  readonly acceleration: number
  /** Fraction of body-X (sideways) velocity deleted per tick. Shipped: 0.045. */
  readonly driftMultiplier: number
  /** Fraction of body-Y (vertical) velocity deleted per tick. Shipped: 0.065. */
  readonly liftMultiplier: number
  /** Angular rates, radians/second-ish in Unity's loose units. */
  readonly rollRate: number
  readonly pitchRate: number
  readonly yawRate: number
  /** Deceleration applied while the brake is held. Shipped: airbrake 5. */
  readonly airbrakeSpeed: number
}

/** Pilot intent for one tick. All axes in [-1, 1]; throttle/brake in [0, 1]. */
export interface HoverJetInput {
  /** Body +Z thrust demand. */
  throttle: number
  /** Boost — doubles thrust while held. In the shipped game this is free. */
  boost: boolean
  /**
   * DEV-410: how much of the boost's extra thrust the tank paid for this tick,
   * 0..1. Absent means the whole boost, which covers every caller except the
   * player's tank (`sim/energy.ts`'s `power`). At an empty Anniversary tank it
   * is recharge / burn, so the boost fades to half instead of cutting out.
   */
  boostPower?: number | undefined
  brake: boolean
  /** Right-hand-positive roll. */
  roll: number
  pitch: number
  yaw: number
}

export const noInput = (): HoverJetInput => ({
  throttle: 0,
  boost: false,
  brake: false,
  roll: 0,
  pitch: 0,
  yaw: 0,
})

export interface HoverJet {
  body: RigidBody
  tuning: HoverJetTuning
  /**
   * Spooled thrust, newtons. Lags the throttle demand by `acceleration`
   * units/second. Persisted across ticks — this is the engine's memory.
   */
  currentThrust: number
  /**
   * Gravity gate. The shipped HoverJet flies with gravity OFF, switched off by
   * `LaunchElevator.FinishLaunch()` — so a ship that has not launched still
   * falls. Modelled honestly rather than baked to false.
   */
  launched: boolean
  /**
   * The speed chain. Every gate raises `maxSpeed`; miss one for long enough and
   * it all falls back. See `sim/speed-chain.ts` — without it the ship tops out
   * at 182 m/s and the 2016 ghosts are physically impossible.
   */
  chain: SpeedChainState
  /** `EnergySystem_Ship`'s two numbers, so the chain needs no extra plumbing. */
  readonly chainSpec: SpeedChainSpec
  /**
   * The sheet this jet was built from: 2016's, or a variant's view of it
   * (DEV-380). Kept so what else reads this jet's numbers — the boost tank,
   * the speed gauge — reads THIS jet's rather than 2016's.
   */
  readonly sheet: HoverJetSheet
}

// Scratch vectors. Module-level and reused every tick: the sim must not
// allocate in its hot path. Only ever valid inside the call that writes them.
const _bodyVel: Vec3 = v3()
const _worldDelta: Vec3 = v3()
const _thrustBody: Vec3 = v3()
const _thrustWorld: Vec3 = v3()
const _torqueBody: Vec3 = v3()
const _torqueWorld: Vec3 = v3()

/**
 * Build a HoverJet from the generated constants sheet. This is the only place
 * tuning values enter the sim, and every one of them is read from the shipped
 * `Resources/PlayerShip_SR14_Photon.prefab` — **not** the `_unet` sibling,
 * which carries identical physics but the opposite `glider_lockRollAndYaw`
 * and is instantiated by two enabled multiplayer scenes. See `_CORRECTIONS.md`
 * C1 and C2: that decoy has already produced two published errors.
 *
 * **The sheet is a PARAMETER, defaulting to itself** (DEV-380). An aircraft
 * variant hands in `hoverJetView(scale)`; everything else — the golden
 * trajectories, the ghosts, the racers — passes nothing and flies 2016. There
 * used to be a `Partial<HoverJetTuning>` of ABSOLUTE overrides here, which no
 * caller ever passed and which was the one door a hand-typed physics number
 * could come through; it is gone, and it did not reach the rigid body anyway.
 */
export const createHoverJet = (sheet: HoverJetSheet = HOVERJET): HoverJet => {
  const ship = sheet.ship
  const rb = sheet.rigidbody

  return {
    body: createRigidBody({
      mass: rb.mass,
      drag: rb.drag,
      angularDrag: rb.angularDrag,
      // Overwritten every tick by the launch gate; the prefab value is the
      // pre-launch state and is the honest starting point.
      useGravity: rb.useGravity,
    }),
    tuning: {
      maxSpeed: ship.maxSpeed,
      boostMultiplier: ship.boostMultiplier,
      acceleration: ship.acceleration,
      driftMultiplier: ship.driftMultiplier,
      liftMultiplier: ship.liftMultiplier,
      rollRate: ship.rollRate,
      pitchRate: ship.pitchRate,
      yawRate: ship.yawRate,
      airbrakeSpeed: ship.airbrakeSpeed,
    },
    currentThrust: 0,
    launched: true,
    chain: createSpeedChain(),
    chainSpec: {
      increment: sheet.speedChain.speedIncreaseAmt,
      cooldownSeconds: sheet.energy.maxCooldownTime,
    },
    sheet,
  }
}

/**
 * Advance one HoverJet by exactly one fixed tick.
 *
 * Order is load-bearing and mirrors Unity's: spool the engine, accumulate
 * thrust and control torque, **then** apply the anisotropic body-space bleed,
 * **then** integrate. Moving the bleed after integration changes the feel and
 * silently breaks the terminal-speed identity the tests assert.
 */
export const stepHoverJet = (jet: HoverJet, input: HoverJetInput, dt: number = FIXED_DT): void => {
  const { body, tuning } = jet

  clearAccumulators(body)

  // ── 0. The speed chain ─────────────────────────────────────────────────
  //
  // `maxSpeed` is not a constant in the shipped game: every gate adds 18 to it
  // and it falls back after 5.5 s without one. Stepped BEFORE the spool so the
  // engine sees this tick's ceiling, not last tick's.
  stepSpeedChain(jet.chain, jet.chainSpec, dt)
  const maxSpeed = chainedMaxSpeed(jet.chain, jet.chainSpec, tuning.maxSpeed)

  // ── 1. Engine spool ────────────────────────────────────────────────────
  // DEV-410: a partly paid boost adds that fraction of the boost's extra
  // thrust. A whole one takes the multiplier itself, not `1 + (m - 1) * 1`,
  // so every unpowered caller's trajectory stays bit-identical.
  const power = input.boostPower
  const boostFactor = !input.boost
    ? 1
    : power === undefined || power >= 1
      ? tuning.boostMultiplier
      : 1 + (tuning.boostMultiplier - 1) * Math.max(0, power)
  const demand = Math.max(0, Math.min(1, input.throttle)) * maxSpeed * boostFactor

  // The spool RATE follows the base tuning rather than the chained ceiling, so a
  // long chain does not also make the engine quicker to answer the throttle.
  const spoolStep = tuning.acceleration * tuning.maxSpeed * dt
  const gap = demand - jet.currentThrust
  jet.currentThrust += gap > spoolStep ? spoolStep : gap < -spoolStep ? -spoolStep : gap

  // ── 2. Thrust along body +Z ────────────────────────────────────────────
  set(_thrustBody, 0, 0, jet.currentThrust)
  rotateVec3(_thrustWorld, body.orientation, _thrustBody)
  scaleAdd(body.force, body.force, _thrustWorld, 1)

  // ── 3. Control torque, body axes ───────────────────────────────────────
  set(
    _torqueBody,
    input.pitch * tuning.pitchRate,
    input.yaw * tuning.yawRate,
    input.roll * tuning.rollRate,
  )
  rotateVec3(_torqueWorld, body.orientation, _torqueBody)
  scaleAdd(body.torque, body.torque, _torqueWorld, 1)

  // ── 4. THE SIGNATURE: anisotropic body-space velocity bleed ────────────
  // Rotate velocity into the body frame, delete a fixed fraction of the
  // sideways and vertical components, rotate the delta back out. Forward
  // (body +Z) is deliberately untouched — Unity's linear drag handles it in
  // `integrate()`, and the gap between the two is the feel.
  rotateVec3Inverse(_bodyVel, body.orientation, body.velocity)
  set(_worldDelta, -_bodyVel.x * tuning.driftMultiplier, -_bodyVel.y * tuning.liftMultiplier, 0)
  rotateVec3(_worldDelta, body.orientation, _worldDelta)
  scaleAdd(body.velocity, body.velocity, _worldDelta, 1)

  // ── 5. Airbrake ────────────────────────────────────────────────────────
  if (input.brake) {
    const bleed = 1 - tuning.airbrakeSpeed * dt
    const k = bleed < 0 ? 0 : bleed
    body.velocity.x *= k
    body.velocity.y *= k
    body.velocity.z *= k
  }

  // ── 6. Integrate ───────────────────────────────────────────────────────
  // `useGravity` is not baked false: the 2016 ship flies with gravity off, but
  // it is `LaunchElevator.FinishLaunch()` that turns it off. Before launch the
  // ship falls, and modelling that honestly keeps the launch sequence possible
  // later instead of requiring a special case.
  body.useGravity = !jet.launched
  integrate(body, GRAVITY, dt)
}
