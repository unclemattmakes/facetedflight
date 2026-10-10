// src/sim/glider.ts — the Anniversary glider. A prototype flight model.
//
// ── What 2016 had, and why none of it is in here ──────────────────────────
//
// There WAS a third vehicle. `Scripts/vehicles/Glider_01..05.cs` are five
// iterations of it; `Resources/PlayerShip_Glider_Photon.prefab` is a player
// ship for it; `Scenes/missions/Glider/` holds six missions; and
// `setGameplayOptions.unity` — a SHIPPED scene — carries level-select tiles for
// it. Every one of those is switched off:
//
//   · all six mission scenes are `enabled: 0` in `EditorBuildSettings.asset`
//   · both glider tiles in the shipped level select carry an `m_Modifications`
//     entry `propertyPath: m_IsActive, value: 0`
//   · `Input_Ship_Glider` on the player prefab is `m_Enabled: 0`
//
// So under hard rule 2 there is **no shipped behaviour to be faithful to**, and
// every number below is new. What 2016 does give us is the SHAPE it was reaching
// for, and that is honoured: on `PlayerShip_Glider_Photon` the rigidbody has
// `useGravity: 1`, `Ship_HoverShip.maxSpeed` is **0** (no thruster at all), and
// `Input_Ship.glider_lockRollAndYaw` is `1` with `rollToYawRatio: 1` — gravity
// on, thrust off, one stick axis banks and yaws together. That is a glider.
//
// What 2016 never reached is aerodynamics. All five iterations are the same
// idea — "bleed vertical velocity, add forward velocity" — and the one on the
// prefab, `Glider_02`, uses `vertVel.magnitude`, which is unsigned, so climbing
// speeds you up too. There is no lift term, no stall and no rocket anywhere in
// the 2016 tree. DEV-145 has the provenance in full.
//
// ── What this model is ────────────────────────────────────────────────────
//
// Matt's brief, from the 2026-09-16 triage: Riders Republic's rocket gliders as
// the reference, and the fun is (a) a dive-to-speed / climb-to-height energy
// trade with an honest stall, (b) a short rocket burst that is a RESOURCE, and
// (c) terrain-hugging pays. Mechanically it is the HoverJet's energy idea with
// the sign flipped: potential <-> kinetic instead of tank <-> thrust.
//
// So, in order, every tick:
//
//   1. airspeed and angle of attack, in the BODY frame
//   2. lift = q * Cl, with Cl proportional to alpha and saturating — so lift
//      is proportional to v^2 and the glider must fly to fly
//   3. drag = q * (parasite + induced), where induced is proportional to Cl^2.
//      **This is the whole energy trade.** Hauling on the stick to climb raises
//      Cl, which raises drag as its square, which costs you the speed you were
//      climbing on. Take the induced term out and the glider becomes a
//      perpetual-motion machine.
//   4. a stall: below `stallSpeed` the wing makes NO lift at all, and most of
//      the control authority goes with it
//   5. weathervane stability toward `trimAngleOfAttack`, which trims the glider
//      hands-off AND drops the nose in a stall, so a stall is recoverable by
//      doing nothing — which is what makes it honest rather than punitive
//   6. the rocket: a fixed thrust along body +Z, spending a fuel budget that
//      recharges slowly. Contrast the HoverJet's boost, which DEV-002 measured
//      as effectively free.
//
// ── Why the tuning is a parameter ─────────────────────────────────────────
//
// Hard rule 3: a numeric literal under `src/sim/` is a code smell. Every number
// the model reads arrives in `GliderTuning`, which is CONTENT, because the
// glider is Anniversary design and not extracted 2016 data. Since DEV-399 that
// content is the AIRCRAFT's, `content/aircraft/glider.json`'s `tuning`, beside
// its variants; it travelled with the one course (`Level.flightModel`) until
// the glider was wired. The only literals in this file are 0 and 1 in clamps
// and sign tests, which are arithmetic and not tuning. `PROTOTYPE_GLIDER` at
// the bottom is the one exception and it is there so a test can construct a
// glider without loading content; it is marked.
//
// ── Purity ────────────────────────────────────────────────────────────────
//
// No three, no DOM, no clock, no RNG (hard rule 4). Fixed dt (hard rule 5).

import { FIXED_DT, GRAVITY } from './constants'
import { rotateVec3, rotateVec3Inverse } from './math/quat'
import { clamp } from './math/scalar'
import { length, scaleAdd, set, type Vec3, v3 } from './math/vec3'
import { clearAccumulators, createRigidBody, integrate, type RigidBody } from './rigidbody'

/**
 * Everything the glider reads. All of it is Anniversary design data — none of
 * it is traceable to 2016 shipped behaviour, because 2016 shipped no glider.
 * See DEV-145 for which of these were chosen against a measurement and which
 * against a monitor.
 */
export interface GliderTuning {
  /** kg. */
  readonly mass: number
  /**
   * Unity `Rigidbody.angularDrag`. The ONLY damping on rotation, so it and the
   * three rates together decide the full-stick rate:
   * `(rate / angularDrag) * (1 - angularDrag * dt)` — the discrete fixed point,
   * not `rate / angularDrag`. See `sim/rigidbody.ts`'s `fullStickRate`, and
   * DEV-027 on why the trailing factor is not pedantry.
   */
  readonly angularDrag: number
  /**
   * Newtons per (m/s)^2 per unit coefficient. `0.5 * rho * S` collapsed into
   * ONE number, because the game has no air density and no wing area and
   * inventing them would be two numbers pretending to be physics.
   *
   * **One scale, shared by lift and drag, and that is load-bearing.** The first
   * version of this file had `liftScale` and `dragScale` as separate fields,
   * which quietly means Cl/Cd is NOT the glide ratio: the real ratio is
   * `(liftScale*Cl)/(dragScale*Cd)`. Tuned for a glide ratio of 12.8 on paper
   * it flew at 4.1 and dived into the sea hands-off, and the probe caught it in
   * one run. With one scale, `Cl / Cd` IS the glide ratio and the arithmetic in
   * `PROTOTYPE_GLIDER` can be checked by eye.
   *
   * It also fixes the ceiling: with one scale, the best glide ratio available
   * at cruise is exactly `(terminalDiveSpeed / cruiseSpeed)^2`. Pick two of
   * those three and the third is decided.
   */
  readonly aeroScale: number
  /** dCl/d(alpha), per radian. A real thin aerofoil is about 2*pi. */
  readonly liftSlope: number
  /** Cl saturates here, in both directions. Past it the wing is at its limit. */
  readonly liftMax: number
  /** Parasite drag coefficient — the drag you pay at zero lift. */
  readonly parasiteDrag: number
  /**
   * Induced-drag factor: `Cd_induced = inducedDrag * Cl^2`. The energy trade
   * lives here. Physically `1 / (pi * AR * e)`.
   */
  readonly inducedDrag: number
  /**
   * m/s. **At or below this airspeed the wing makes no lift at all.** Not a
   * soft mush — a cliff, so "it stalled" is a thing a player can feel and a
   * test can assert.
   */
  readonly stallSpeed: number
  /**
   * m/s. Lift authority ramps linearly from 0 at `stallSpeed` to full at
   * `stallSpeed + stallWidth`, so the edge is felt before it is fallen off.
   */
  readonly stallWidth: number
  /**
   * Fraction of control authority that survives a full stall, 0..1. Not zero:
   * a glider with no controls at all is a rock, and the player has to be able
   * to help the nose down.
   */
  readonly stalledControl: number
  /**
   * radians. The angle of attack the airframe is rigged to fly at. Weathervane
   * stability pulls toward THIS, not toward zero — which is what makes the
   * glider hold altitude hands-off, and what drops the nose when it stalls.
   */
  readonly trimAngleOfAttack: number
  /** Weathervane strength: pitching torque per (m/s)^2 per radian of alpha error. */
  readonly weathervane: number
  /**
   * The FIN. Yawing torque per (m/s)^2 per radian of sideslip.
   *
   * Directional stability, and without it this vehicle cannot turn. Banking
   * tilts the lift vector, which curves the FLIGHT PATH — but nothing then
   * brings the nose round to follow it, so the glider skids sideways with the
   * nose still pointing where it started, `sideBleed` eats the sideslip, and
   * the heading never changes. The first autopilot run flew straight out of the
   * course and 14 km into the sea holding full roll the whole way.
   *
   * A real aircraft turns with the fin, not with the rudder, and so does this.
   */
  readonly weathervaneYaw: number
  /** Aerodynamic pitch damping per (m/s)^2 per rad/s. Kills the phugoid. */
  readonly pitchDamping: number
  /** Control torques at full stick, body axes. */
  readonly rollRate: number
  readonly pitchRate: number
  readonly yawRate: number
  /**
   * Fraction of body-X (sideways) velocity deleted per tick, at full authority.
   * The HoverJet's signature mechanic, borrowed at a gentler setting: a wing
   * does not slide sideways, and a stalled one does.
   */
  readonly sideBleed: number
  /** Newtons along body +Z while the rocket burns. */
  readonly rocketThrust: number
  /** Seconds of burn in a full tank. */
  readonly rocketSeconds: number
  /** Seconds of fuel regained per second, while NOT burning. Below 1, or it is free. */
  readonly rocketRecharge: number
  /**
   * metres. Below this clearance the wing gains lift — the reason
   * terrain-hugging pays. Linear from 0 extra at this height to
   * `groundEffectGain` extra on the deck.
   */
  readonly groundEffectHeight: number
  /** Extra lift as a FRACTION, on the deck. 0.3 means +30 %. */
  readonly groundEffectGain: number
}

/**
 * Pilot intent for one tick. Axes in [-1, 1], and the SAME convention as
 * `HoverJetInput`: each is a torque demand about the matching body axis, so
 * positive `pitch` pitches the nose DOWN. That is not a typo and it is not a
 * choice — `stepHoverJet` writes `input.pitch * pitchRate` into body +X, and a
 * positive rotation about +X carries the nose (+Z) toward -Y. A glider that
 * disagreed with the ship about which way back is would be its own bug class
 * (DEV-069, DEV-071: the keyboard climbed while the stick dived).
 */
export interface GliderInput {
  /** Right-hand-positive roll. */
  roll: number
  /** Positive pitches the nose DOWN. See the note above. */
  pitch: number
  yaw: number
  /** Hold to burn the rocket. Does nothing with an empty tank. */
  rocket: boolean
}

export const noGliderInput = (): GliderInput => ({ roll: 0, pitch: 0, yaw: 0, rocket: false })

export interface Glider {
  body: RigidBody
  readonly tuning: GliderTuning
  /**
   * Seconds of rocket left. The resource. Starts full.
   */
  fuel: number
  /**
   * METRES from the hull to the surface below, or `Infinity` when unknown.
   * Written by the caller BEFORE `stepGlider` — `game/flight.ts` already
   * computes exactly this for G1 (DEV-110), so ground effect costs no extra
   * height sample. Left at `Infinity` the model simply has no ground effect,
   * which is the honest behaviour for a caller that does not know.
   */
  clearance: number

  // ── read-only telemetry, rewritten every tick ────────────────────────────
  // The HUD and the tests both want these, and recomputing them outside would
  // be a second opinion about the same physics. See DEV-069: a value nothing
  // reads is documentation, so these exist to BE read.

  /** m/s, this tick. */
  airspeed: number
  /** radians. Positive = airflow from below = nose up relative to the flight path. */
  angleOfAttack: number
  /** 0..1. 0 is a full stall. */
  liftAuthority: number
  /** Newtons of lift produced this tick, along body +Y. */
  lift: number
  /** Newtons of drag produced this tick, against the flight path. */
  drag: number
  /** True while the rocket is actually burning (held AND fuelled). */
  burning: boolean
}

// Scratch. Module-level and reused: the sim does not allocate in its hot path.
// Valid ONLY inside the synchronous call that writes them — never store one,
// never read one a previous call left behind (trap 19, DEV-032).
const _bodyVel: Vec3 = v3()
const _forceBody: Vec3 = v3()
const _forceWorld: Vec3 = v3()
const _torqueBody: Vec3 = v3()
const _torqueWorld: Vec3 = v3()
const _bodyOmega: Vec3 = v3()
const _bleedBody: Vec3 = v3()

export const createGlider = (tuning: GliderTuning): Glider => ({
  body: createRigidBody({
    mass: tuning.mass,
    // ZERO linear drag, deliberately. Unity's `Rigidbody.drag` is a linear
    // multiplier (`v *= 1 - drag*dt`) and the whole point of this model is that
    // resistance goes as v^2 — a linear term on top would quietly flatten the
    // dive-to-speed trade the vehicle exists for. All drag here is aerodynamic.
    drag: 0,
    angularDrag: tuning.angularDrag,
    // Gravity ON. The one thing the 2016 glider prefab is unambiguous about
    // (`m_UseGravity: 1`), and the opposite of the HoverJet, which flies with
    // gravity switched off by `LaunchElevator.FinishLaunch()`.
    useGravity: true,
  }),
  tuning,
  fuel: tuning.rocketSeconds,
  clearance: Number.POSITIVE_INFINITY,
  airspeed: 0,
  angleOfAttack: 0,
  liftAuthority: 0,
  lift: 0,
  drag: 0,
  burning: false,
})

/**
 * Lift authority: 0 at or below `stallSpeed`, 1 at `stallSpeed + stallWidth`,
 * linear between. Exported because the HUD wants to draw the same number the
 * physics used, and because a test should be able to assert the cliff without
 * flying to it.
 */
export const liftAuthorityAt = (tuning: GliderTuning, airspeed: number): number =>
  clamp((airspeed - tuning.stallSpeed) / tuning.stallWidth, 0, 1)

/**
 * Ground-effect lift multiplier for a given clearance. 1 outside
 * `groundEffectHeight`, `1 + groundEffectGain` on the deck.
 */
export const groundEffectAt = (tuning: GliderTuning, clearance: number): number => {
  if (!(clearance < tuning.groundEffectHeight)) return 1
  const near = clamp(1 - Math.max(clearance, 0) / tuning.groundEffectHeight, 0, 1)
  return 1 + tuning.groundEffectGain * near
}

/**
 * The speed at which the glider can just hold altitude in level flight, with
 * the wing at `liftMax` and no ground effect. Derived, not tuned:
 * `aeroScale * v^2 * liftMax = mass * |g|`.
 *
 * This is the number that decides whether `stallSpeed` is reachable at all. If
 * it comes out BELOW `stallSpeed` the hard cliff is unreachable and the stall
 * is decorative; if it comes out far above, the glider mushes forever and never
 * cleanly lets go. `tests/unit/glider.test.ts` asserts it lands inside the
 * stall band, which is the only place both halves are felt.
 */
export const minimumLevelSpeed = (tuning: GliderTuning, gravity = GRAVITY): number =>
  Math.sqrt((tuning.mass * Math.abs(gravity.y)) / (tuning.aeroScale * tuning.liftMax))

/**
 * The speed the glider TRIMS at: level lift with the wing at
 * `trimAngleOfAttack`, `aeroScale * v^2 * liftSlope * trim = mass * |g|`.
 * Derived, not tuned. It is DEV-145's second chosen number (cruise 55 m/s)
 * read back out of the solved fields, and the settled hands-off glide measures
 * 54.7 against it, the gap being the glide's own sink.
 *
 * DEV-399: what a glider is LAUNCHED at. A spawn, a respawn, anything that
 * puts one in the air at rest would otherwise start it inside its own stall.
 */
export const trimSpeed = (tuning: GliderTuning, gravity = GRAVITY): number =>
  Math.sqrt(
    (tuning.mass * Math.abs(gravity.y)) /
      (tuning.aeroScale * tuning.liftSlope * tuning.trimAngleOfAttack),
  )

/**
 * The zero-lift terminal dive: `aeroScale * v^2 * parasiteDrag = mass * |g|`,
 * DEV-145's FIRST chosen number (170 m/s). An asymptote rather than a speed you
 * reach: a held-forward stick makes negative lift and pays induced drag for
 * it, so the measured dive tops out near 145. The glider's TOP SPEED bar and
 * its speed gauge's full scale (DEV-399), because nothing flies faster.
 */
export const terminalDiveSpeed = (tuning: GliderTuning, gravity = GRAVITY): number =>
  Math.sqrt((tuning.mass * Math.abs(gravity.y)) / (tuning.aeroScale * tuning.parasiteDrag))

/**
 * How far above the stall the glider is flying, 0..1: 0 at `stallSpeed`,
 * where the wing lets go, and 1 at {@link trimSpeed}, where it wants to fly.
 * DEV-399's HUD row, so the bar drains on the way to the cliff rather than
 * reading full until the last 10 m/s the way `liftAuthority` does.
 */
export const stallMarginAt = (tuning: GliderTuning, airspeed: number): number =>
  clamp((airspeed - tuning.stallSpeed) / (trimSpeed(tuning) - tuning.stallSpeed), 0, 1)

/**
 * Set a glider flying at its trim speed along its NOSE (body +Z), spinning
 * nothing. What a direct launch does (DEV-399): the level's spawn marker says
 * where and which way, and this is how fast.
 */
export const launchGlider = (glider: Glider, gravity = GRAVITY): void => {
  const v = trimSpeed(glider.tuning, gravity)
  set(_bodyVel, 0, 0, v)
  rotateVec3(glider.body.velocity, glider.body.orientation, _bodyVel)
  set(glider.body.angularVelocity, 0, 0, 0)
  // The telemetry follows the launch, so an instrument read before the first
  // tick reads this glider — flying at trim — and not a fresh one at rest,
  // which would say "stalled" for the frames between boarding and flying.
  glider.airspeed = v
  // Along the nose, so no angle of attack yet: the weathervane brings it to
  // trim over the first second, as it does from any launch.
  glider.angleOfAttack = 0
  glider.liftAuthority = liftAuthorityAt(glider.tuning, v)
}

/** The rocket full again, as a reload leaves it. DEV-399's crash and respawn. */
export const refuelGlider = (glider: Glider): void => {
  glider.fuel = glider.tuning.rocketSeconds
}

/**
 * Advance one glider by exactly one fixed tick.
 *
 * Order mirrors `stepHoverJet`: measure, accumulate forces and torques, apply
 * the per-tick body-space bleed, integrate. Gravity is applied by `integrate`.
 */
export const stepGlider = (glider: Glider, input: GliderInput, dt: number = FIXED_DT): void => {
  const { body, tuning } = glider

  clearAccumulators(body)

  // ── 1. The airflow, in the body frame ──────────────────────────────────
  rotateVec3Inverse(_bodyVel, body.orientation, body.velocity)
  const v = length(_bodyVel)
  glider.airspeed = v

  // Angle of attack. Positive when the airflow arrives from below, i.e. the
  // nose is above the flight path — which is the sign convention that makes
  // "pull back to make lift" true.
  //
  // Flying BACKWARDS (body-Z velocity <= 0) is not an angle of attack, it is a
  // wing pointing the wrong way, and `atan2` would hand back something past 90
  // degrees that `liftMax` would then clamp into a confident wrong answer. A
  // wing flying backwards makes no lift; say so.
  // `atan2` is taken over the WHOLE circle, so a glider flying backwards or
  // straight down reports an alpha past 90 degrees rather than a clamped lie.
  // That matters for the weathervane below, which is the only thing that can
  // get it pointing forwards again.
  const flying = _bodyVel.z > 0
  const alpha = v > 0 ? Math.atan2(-_bodyVel.y, _bodyVel.z) : 0
  glider.angleOfAttack = alpha

  // ── 2. Stall ───────────────────────────────────────────────────────────
  const authority = flying ? liftAuthorityAt(tuning, v) : 0
  glider.liftAuthority = authority

  // ── 3. Lift and drag ───────────────────────────────────────────────────
  //
  // `q` is dynamic pressure with the area folded in — the v^2 the brief asks
  // for, and the reason speed is the currency.
  const q = v * v
  const cl = flying
    ? clamp(tuning.liftSlope * alpha, -tuning.liftMax, tuning.liftMax) * authority
    : 0
  const lift = tuning.aeroScale * q * cl * groundEffectAt(tuning, glider.clearance)
  glider.lift = lift

  // Induced drag goes as Cl SQUARED. That is the energy trade: a hard pull
  // buys height and is billed in speed, quadratically. Parasite drag is paid
  // whatever the wing is doing, including flying backwards.
  const cd = tuning.parasiteDrag + tuning.inducedDrag * cl * cl
  const dragMag = tuning.aeroScale * q * cd
  glider.drag = dragMag

  // ── Directions ─────────────────────────────────────────────────────────
  //
  // Drag acts against the flight path. Lift acts PERPENDICULAR to it, in the
  // plane the flight path shares with body +Y — stability axes, not body axes.
  //
  // **Body +Y is the tempting simplification and it is wrong by a measurable
  // amount.** Tilted back from the airflow normal by alpha, a body-+Y lift
  // vector contributes `L * sin(alpha)` of extra retarding force, so the glide
  // ratio becomes `Cl / (Cd + Cl*tan(alpha))` instead of `Cl / Cd`. At this
  // vehicle's trim that is 4.73 : 1 where the tuning says 7 : 1 — a third of the
  // glide, silently, from a term nobody wrote down. Measured, not reasoned: the
  // settled hands-off glide came out 4.73 and the force balance only closed
  // once `L*sin(alpha)` was added to it.
  //
  // It still rolls with the airframe, so banking still turns — that part of the
  // simplification was never the problem.
  set(_forceBody, 0, lift, 0)
  if (v > 0) {
    const inv = 1 / v
    const hx = _bodyVel.x * inv
    const hy = _bodyVel.y * inv
    const hz = _bodyVel.z * inv
    // Body +Y with its along-flow component removed.
    const lx = -hx * hy
    const ly = 1 - hy * hy
    const lz = -hz * hy
    const ln = Math.sqrt(lx * lx + ly * ly + lz * lz)
    // Degenerate only when the airflow runs exactly along body +Y — a pure
    // sideways-on fall. Body +Y is then as good an answer as any.
    if (ln > 1e-6) {
      const k = lift / ln
      set(_forceBody, lx * k, ly * k, lz * k)
    }
    _forceBody.x -= hx * dragMag
    _forceBody.y -= hy * dragMag
    _forceBody.z -= hz * dragMag
  }

  // ── 4. The rocket ──────────────────────────────────────────────────────
  //
  // A RESOURCE, unlike the HoverJet's boost, which DEV-002 measured as free at
  // +68/s net. Fuel burns while held and comes back only once RELEASED.
  //
  // "Once released" and not "while not burning", and the difference is a bug
  // the tests caught: with the recharge on `!burning`, a held button on an
  // empty tank refills for one tick, spends it on the next, and the rocket
  // micro-bursts for ever at `rocketRecharge` duty. Holding it down would have
  // been free thrust — the exact thing this vehicle exists NOT to have.
  const burning = input.rocket && glider.fuel > 0
  glider.burning = burning
  if (burning) {
    _forceBody.z += tuning.rocketThrust
    glider.fuel = Math.max(0, glider.fuel - dt)
  } else if (!input.rocket) {
    glider.fuel = Math.min(tuning.rocketSeconds, glider.fuel + tuning.rocketRecharge * dt)
  }

  rotateVec3(_forceWorld, body.orientation, _forceBody)
  scaleAdd(body.force, body.force, _forceWorld, 1)

  // ── 5. Torques ─────────────────────────────────────────────────────────
  //
  // Control authority collapses with lift authority, but not to nothing: a
  // stalled glider you cannot point is a rock, and the player needs to be able
  // to help the nose down.
  const control = tuning.stalledControl + (1 - tuning.stalledControl) * authority

  // Weathervane, toward `trimAngleOfAttack` and NOT toward zero. Two jobs in
  // one term: hands-off the glider settles at its best-glide attitude, and in a
  // stall — where the airflow arrives from far below, so alpha is large — it
  // pitches the nose DOWN into the dive that recovers the speed. Self-recovery
  // without a special case.
  //
  // It is deliberately NOT scaled by `control`: the airframe's own stability
  // does not depend on the pilot, and switching it off in the stall would make
  // the stall unrecoverable. It is also NOT gated on `flying` — an airframe
  // pointing the wrong way is exactly when its own stability is the only thing
  // that can save it, and gating it there makes a tumble permanent.
  //
  // **The SIGN is +, and that is not the sign the algebra suggests.** Body +X
  // torque pitches the nose DOWN (right-hand rule about +X takes +Z toward -Y,
  // and +Z is the nose), so "alpha is above trim, put the nose down" is a
  // POSITIVE torque. Written with the intuitive minus, the glider pitched away
  // from the airflow, tumbled onto its back and fell at terminal velocity from
  // every initial condition — which is the orientation lesson exactly: a sign
  // derived from what you believe is your belief written twice.
  // `tests/unit/glider.test.ts` pins it by comparing against `stepHoverJet`,
  // which is outside this module and already shipped.
  const restoring = tuning.weathervane * q * (alpha - tuning.trimAngleOfAttack)

  // Aerodynamic pitch damping, in the BODY frame, against the body-X rate.
  // Without it the weathervane and the wing form an undamped oscillator and the
  // glider porpoises.
  rotateVec3Inverse(_bodyOmega, body.orientation, body.angularVelocity)
  const damping = -tuning.pitchDamping * q * _bodyOmega.x

  // Sideslip, and the fin that removes it. `beta` is positive when the airflow
  // arrives from the RIGHT, which means the nose is left of the flight path, so
  // the nose must yaw right — and a positive body +Y torque carries the nose
  // (+Z) toward +X, which is right. Same sign as the pitch term, for the same
  // reason, and not gated on `control` for the same reason either.
  const beta = v > 0 ? Math.atan2(_bodyVel.x, _bodyVel.z) : 0
  const fin = tuning.weathervaneYaw * q * beta

  set(
    _torqueBody,
    input.pitch * tuning.pitchRate * control + restoring + damping,
    input.yaw * tuning.yawRate * control + fin,
    input.roll * tuning.rollRate * control,
  )
  rotateVec3(_torqueWorld, body.orientation, _torqueBody)
  scaleAdd(body.torque, body.torque, _torqueWorld, 1)

  // ── 6. Sideways bleed ──────────────────────────────────────────────────
  //
  // The HoverJet's signature, borrowed and softened. Scaled by authority, so a
  // stalled glider really does slide sideways — which looks as bad as it should.
  set(_bleedBody, -_bodyVel.x * tuning.sideBleed * authority, 0, 0)
  rotateVec3(_bleedBody, body.orientation, _bleedBody)
  scaleAdd(body.velocity, body.velocity, _bleedBody, 1)

  // ── 7. Integrate ───────────────────────────────────────────────────────
  integrate(body, GRAVITY, dt)
}

/**
 * The prototype's tuning, as a TypeScript constant.
 *
 * **This is the one place in `src/sim/` that holds glider numbers, and it is
 * here under protest.** The shipping source of these values is
 * `content/aircraft/glider.json`'s `tuning` (DEV-399; the course carried them
 * as `Level.flightModel.tuning` before that); this copy exists so a unit test
 * or a scratch script can start from a known-good baseline without loading
 * content, and `tests/unit/glider-mission.test.ts` asserts the two agree field
 * for field — so they cannot drift the way `SHIP_MODEL_YAW`'s copy drifted.
 *
 * Every number is Anniversary. Three of them were CHOSEN and the rest are
 * SOLVED from those three, against `mass * |g|` = 4 x 32 = **128 N** of weight:
 *
 *   chosen   terminal dive speed   170 m/s   (the HoverJet boosts to 179.6)
 *   chosen   cruise trim speed      55 m/s
 *   chosen   glide ratio at trim     7 : 1
 *
 *   solved   aeroScale   0.177163   = 128 / (170^2 * parasiteDrag)
 *   solved   liftMax     0.55748    so `minimumLevelSpeed` is exactly 36.0 m/s,
 *                                   which sits inside the 32..42 stall band —
 *                                   the only place both the mush and the cliff
 *                                   are felt
 *   solved   inducedDrag 0.15988    from Cl/(Cd0 + k*Cl^2) = 7 at Cl 0.23884
 *   solved   trimAngleOfAttack      0.06824 rad = 3.91 deg = Cl 0.23884 / 3.5
 *
 * The ceiling is worth writing down because it is not obvious: with one
 * `aeroScale`, the best glide ratio reachable at cruise is exactly
 * `(170/55)^2 = 9.55`. Asking for 12.8 — which is what the first draft of this
 * file asked for — is not a tuning choice, it is arithmetically impossible, and
 * the model answered by diving into the sea.
 *
 * The rest, chosen by eye and stated so:
 *
 *   mass 4                the HoverJet's, so the cockpit's inertia is familiar
 *   angularDrag 2.2       chosen with the rates below
 *   parasiteDrag 0.025    a plausible clean-wing zero-lift Cd
 *   liftSlope 3.5         puts Cl saturation at 0.159 rad = 9.1 deg of alpha
 *   stallSpeed 32         see liftMax above
 *   stallWidth 10         the band, 32..42 m/s
 *   stalledControl 0.25   a quarter of the stick survives a full stall
 *   weathervane 0.002     gives ~0.14 rad/s of restoring rate per 0.05 rad of
 *                         alpha error at cruise
 *   weathervaneYaw        the fin, 80 % of the tailplane. Weaker on purpose:
 *     0.0016              a glider that snapped its nose onto the flight path
 *                         would have no sideslip to bank against
 *   pitchDamping 0.0012   enough to stop the porpoise; measured, not derived
 *   rollRate 4.7347       full stick = 2.094 rad/s = 120 deg/s, against the
 *                         HoverJet's measured 1.5019 rad/s / 86 deg/s
 *   pitchRate 2.1701      NOT a rate. Pitch fights the weathervane, so full
 *                         stick reaches a NEW TRIM rather than a steady
 *                         rotation: `pitchRate / (weathervane * v^2)` = 0.37 rad
 *                         = 21 deg of commanded alpha at cruise, which is past
 *                         the wing's 9.1 deg saturation. Full back stick stalls
 *                         the wing at cruise speed, deliberately.
 *   yawRate 0.7891        measured 17 deg/s at cruise — gliders yaw badly, on
 *                         purpose, and this one yaws worse than the arithmetic
 *                         because the sideslip it makes is bled away
 *   sideBleed 0.02        under half the HoverJet's 0.045 body-X bleed
 *   rocketThrust 180      1.4x the vehicle's weight
 *   rocketSeconds 3       a burst, not a throttle
 *   rocketRecharge 0.25   12 s from empty to full
 *   groundEffect 30 m /   +30 % lift on the deck, fading to nothing at 30 m
 *     0.3
 *
 * ── What it MEASURES, flown headless ──────────────────────────────────────
 *
 * Every line here came out of `stepGlider` rather than out of the algebra, and
 * `tests/unit/glider.test.ts` re-measures all of them. DEV-027: a number you
 * computed yourself needs a test, or it gets quoted in a comment and built on.
 *
 *   settled hands-off     54.7 m/s at alpha 3.91 deg, glide **7.00 : 1**,
 *                         sink 7.74 m/s. The phugoid is real and lightly damped
 *                         — released at 55 m/s it swings 52.6 / 56.7 / 53.6 and
 *                         is gone by 45 s. That is what a glider does.
 *   terminal dive         145 m/s with the stick held forward; 170 m/s is the
 *                         zero-lift asymptote and you cannot reach it, because
 *                         holding the nose down makes negative lift and pays
 *                         induced drag for it
 *   stall                 released at 15, 25 and 34 m/s the wing goes to zero
 *                         authority, the nose drops on its own, and full
 *                         authority is back in 1.1-1.3 s for 200-370 m of
 *                         altitude. Costly, survivable, no input required.
 *   dive to speed         6 s at 40 deg nose-down: 55 -> 104 m/s for 286 m, and
 *                         **98.8 % of specific energy kept**. The trade is
 *                         nearly lossless going down.
 *   climb to height       from 140 m/s, a 0.35 pull reaches +106 m where a
 *                         lossless trade to 55 m/s would give +259 m. 41 %.
 *                         Going up is where induced drag bills you, which is
 *                         exactly the asymmetry the mode is built on.
 *   rocket                3 s from 55 m/s reaches 144 m/s; full again 12 s
 *                         after release
 *   ground effect         31 % less sink over 30 s at 5 m clearance
 *
 * **Every one of these was chosen and measured on a MONITOR against arithmetic.
 * Not one has been flown in a headset, or by a human at all.** DEV-145 says so.
 */
export const PROTOTYPE_GLIDER: GliderTuning = {
  mass: 4,
  angularDrag: 2.2,
  aeroScale: 0.177163,
  liftSlope: 3.5,
  liftMax: 0.55748,
  parasiteDrag: 0.025,
  inducedDrag: 0.15988,
  stallSpeed: 32,
  stallWidth: 10,
  stalledControl: 0.25,
  trimAngleOfAttack: 0.06824,
  weathervane: 0.002,
  weathervaneYaw: 0.0016,
  pitchDamping: 0.0012,
  rollRate: 4.7347,
  pitchRate: 2.1701,
  yawRate: 0.7891,
  sideBleed: 0.02,
  rocketThrust: 180,
  rocketSeconds: 3,
  rocketRecharge: 0.25,
  groundEffectHeight: 30,
  groundEffectGain: 0.3,
}
