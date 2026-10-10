// src/sim/jumpseat-legs.ts — the JumpSeat's four springy legs. REAL, not art.
//
// Matt, 2026-09-12, answering the spec's OQ-1 and the sheet's own "cosmetic"
// note in one sentence:
//
//   *"jumpseat's legs: these were 'springy legs', so when the jumpseat was in
//    the air - the legs would sag a bit. and they'd cushion the landings."*
//
// So they are simulated, and they are ALWAYS DEPLOYED — which independently
// confirms the port's reading that `LandingGearManager` never retracts them
// (`sim/jumpseat.ts`'s header has that argument in full). The chassis stays
// **15 kg**: the four legs are separate `Rigidbody`s on `HingeJoint`s, and in
// Unity a jointed child's mass does not add to its parent's.
//
// ── What is on the prefab ─────────────────────────────────────────────────
//
// Four `HingeJoint`s (`!u!59`), not `ConfigurableJoint`s — the research brief's
// premise was refuted at `JumpSeat_Photon.prefab:7582` and the sheet carries the
// four of them as `JUMPSEAT.legs`. Every number below is read from there.
//
//   leg       pos in ship-root     spring  damper  target  limits     useLimits
//   back_l    (-1.5, -0.45, -1.48)   450      48      0     -35..80      FALSE
//   back_r    ( 1.5, -0.45, -1.48)   450      48      0     -35..80      FALSE
//   front_l   (-1.5, -0.45,  1.56)   450      48     -1     -35..150     FALSE
//   front_r   ( 1.5, -0.45,  1.56)   450      48     -1     -35..150     FALSE
//
// `m_UseLimits: 0` on all four, so **the limits are INERT** and this file does
// not implement them. Said out loud because the numbers are right there in the
// sheet and a future reader will otherwise "fix" their absence. They are not
// useless, though — see the unit argument below, where they are evidence.
//
// **`targetPosition` is 0 on the back pair and -1 on the front pair.** That
// asymmetry is authored and it is kept: it is worth about a degree of extra
// reach on the front feet, which is what makes the sag read as a STANCE rather
// than as four identical droops.
//
// ── The unit question, and what it was decided on ─────────────────────────
//
// Unity's `JointSpring.targetPosition` is in DEGREES — it is the same quantity
// as `HingeJoint.angle`, and the front pair's -1 is a one-degree nudge, not a
// one-radian (57°) fold. That much is not in doubt.
//
// **Whether `spring` is a torque per DEGREE or per RADIAN of hinge error is not
// settled by the YAML**, and the two readings are a factor of 57.3 apart: the
// difference between legs that visibly work and legs that cannot move. It is
// exactly the place the brief warned about, so here is the reasoning and what
// it rests on. Four independent lines, all pointing at **per RADIAN**:
//
//  1. **The authored limits.** `-35..150°` is a range someone typed because
//     they expected the leg to travel tens of degrees. Per radian, a leg
//     carrying its share of the parked chassis sits about 15° down (the hover
//     motor carries the rest — see below) and up to ~33° under the full weight:
//     inside the authored range, using it. Per degree the same load gives
//     **0.59°**, which would make those limits 3 000x out of reach and
//     meaningless.
//  2. **The tuning trajectory.** The project's OTHER four-legged hinge rig,
//     `PlayerShip_HoverChair_Photon_Phys.prefab:9039+` (identical anchor (0,1,0)
//     and axis (1,0,0)), is spring 250 / damper **1.5** / target 1 with limits
//     ON. The JumpSeat is 450 / **48** with limits off — the damper went up
//     32-fold. Per radian that is a move from zeta 0.07 (rings for seconds) to
//     **zeta 1.72**, which is where a person cranking a damper until the wobble
//     stops actually lands. Per degree it is a move from 0.55 to **12.9**, i.e.
//     from "a couple of visible bounces" to "set in mud", which nobody tunes
//     toward.
//  3. **Matt saw them.** Per radian the static droop is 0.89° — 3.5 cm at the
//     foot — under one unit of this world's gravity, and several times that
//     under thrust or on touchdown. Per degree it is 0.0155°, **0.7 mm**. A
//     0.7 mm droop is not a thing anyone remembers ten years later.
//  4. **Integrability.** Per degree the system's fast mode has a time constant
//     of 0.16 ms, 76x SHORTER than the fixed step — a spring no explicit
//     fixed-step port can integrate and that PhysX would resolve as a weld.
//     "Springy legs" is not a description of a weld.
//
// It is still a judgement, so it is ONE NUMBER and the test names the
// alternative next to it, exactly as `tuning.mass` does for OQ-1:
// `LEG_SPRING_UNITS_PER_RADIAN`. Flip it to `180 / Math.PI` and you have the
// per-degree reading with no other edit. Recorded as **OQ-6**, and CLOSED the
// same day: Matt, who built the game, said the legs *"would sag a bit"* — and
// per degree that sag is **0.7 mm**. Testimony from the person who watched them
// discriminates 3.5 cm from 0.7 mm by a factor of fifty. A Unity 5.4 runtime
// would still confirm it; nothing else will, and nothing else needs to.
//
// ── The model: four 1-DOF sprung pendulums, at the fixed step ─────────────
//
// Per leg, one scalar angle about one axis:
//
//     I·θ̈ = -k(θ - θtarget) - c·θ̇ + r·(m·g_eff · ŝ(θ)) + d·(F_ground · ŝ(θ))
//
//   I   0.43118 kg·m²  the capsule's own transverse inertia about its centre
//                      (0.18118) plus m·r² (0.25). It is the inertia of the
//                      leg ABOUT ITS HINGE, about an axis perpendicular to the
//                      capsule's long axis — which the hinge is.
//   r   1.0 m          pivot -> centre of mass. The enabled collider is a
//                      capsule centred on the leg's own origin, so Unity's
//                      computed centre of mass IS that origin and `|anchor|`
//                      is the true lever. (The `foot_00` boxes are disabled and
//                      contribute no mass.)
//   d   2.52 m         pivot -> the capsule's bottom cap: |anchor| + h/2.
//   ŝ(θ)               the direction the foot travels for +θ. Always has a
//                      POSITIVE vertical component, so +θ lifts the foot.
//
// **`g_eff` is gravity MINUS the chassis's own acceleration**, which is what a
// leg hanging off an accelerating chassis actually feels. Two consequences that
// are the whole behaviour:
//
//  - In free fall the chassis and the legs accelerate together, `g_eff` is
//    zero, and the legs float to their target. Coasting at terminal velocity
//    the chassis is not accelerating, `g_eff` is a full 32 m/s², and they sag.
//    Climbing at full thrust it is 50 and they sag half again as far.
//  - On touchdown the chassis decelerates hard, `g_eff` spikes by an order of
//    magnitude, and the legs swing. That is the visible half of "cushion".
//
// The acceleration is MEASURED from the chassis's velocity across the previous
// tick, not computed from `body.force`. That is deliberate: the hover motor's
// impulse and the terrain collision's velocity edit are not forces, and a
// force-derived acceleration is blind to exactly the two events a landing gear
// exists for.
//
// ── How the legs cushion, given they cannot touch `terrain-collision.ts` ──
//
// The feet reach 1.20 m below the ship-root origin; the collision hull's
// lowest sphere is at 0.61 m. So **the feet touch first**, and this file gives
// them the ground rule the hull does not have:
//
//  1. If a foot is under the terrain, solve in closed form for the hinge angle
//     that puts it exactly ON the surface, and pin the leg there. A 0.25 kg leg
//     does not push a planet out of the way; the ground wins, and pinning it
//     needs no invented contact stiffness.
//  2. The spring and damper are then compressed by however much the geometry
//     says, and the force they are pushing with is what the chassis feels —
//     applied at the hinge, upward, and clamped at zero so a leg can never pull
//     the seat down.
//
// That is a suspension: the load builds over the compression rather than
// arriving in the one tick the hull would take it in.
//
// ── What it measures out at ───────────────────────────────────────────────
//
// Every one of these is read off the running model in
// `tests/unit/jumpseat-legs.test.ts`, not computed from the formulae above.
//
//   SAG        back pair  -0.88°   3.4 cm at the foot   \  chassis at a = 0
//              front pair -1.87°   7.1 cm               /  (hover, or terminal)
//              under thrust        x1.56, because g_eff is 50 and not 32
//              in free fall        ~0°: the legs are falling too
//
//   CUSHION    peak upward acceleration of the CHASSIS, m/s², legs vs no legs
//              set-down  1.6 m     7.3 against 197.2     27x, and it never
//                                                        reaches the hull
//              landing   3 m     164.6 against 448.3     2.7x
//              heavy     6 m     679.3 against 866.0     1.3x
//              crash   300 m    3616   against 3674      1.02x — bottomed out
//
//   PARKED     the seat rests on its GEAR at 1.12 m rather than on its hull at
//              0.61 m, all four legs squatting 5.9°, carrying 100 N of its
//              480 N while the hover motor carries the rest.
//
// (DEV-530 moved every number in that table a little: the feet used to be
// reconstructed from a disabled foot box, and `front_l`'s stood 0.2 m lower
// than the rest. It touched first and took the most, so the seat parked at
// 1.14 m with that leg at 10° and the others at 4-5°, and the 3 m landing was
// 3.3x rather than 2.7x.)
//
// The shape of that table is the point: a landing gear absorbs a landing and
// bottoms out in a crash. 0.6 m of travel at 47 m/s is thirteen milliseconds,
// and four 450 N·m springs do not absorb 14.5 kJ in thirteen milliseconds.
//
// **The sag is small.** 3.4 cm on a 2.5 m leg is 1.4 % of its length, and it is
// reported here rather than scaled up to be obvious: the number is the number.
// What reads at a glance is the squat — about 6° when the gear takes the weight
// — and the swing on touchdown, which is tens of degrees.
//
// ── What this trades, deliberately ────────────────────────────────────────
//
//  - **The reaction is a LINEAR force with no torque.** `rigidbody.ts:84-88`
//    models the inertia tensor as a scalar 1 (the fitted one is what PORT_PLAN
//    §3 M1.5 exists to produce), so feeding it a real newton-metre would spin
//    the seat at hundreds of rad/s². Asymmetric leg loading therefore does not
//    yet pitch or roll the chassis. One line, the day M1.5 lands.
//  - **The hinge is 2016's, composed, not reconstructed** (DEV-530). The leg's
//    enabled capsule shares its GameObject with the HingeJoint's rigidbody, and
//    the sheet carries that collider's frame composed to the prefab root
//    (`composedFromShipRoot`). So the pivot is `anchor`, the hinge is `axis`
//    and the foot is the capsule's bottom end, all three in that frame. Until
//    DEV-530 the strut was aimed from the leg's origin at the LOWEST collider
//    under it — a DISABLED `foot_00` box, a different size on every leg — and
//    the hinge was taken square to it in the vertical plane: 2.70° / 4.24° /
//    3.59° / 3.18° off 2016's, and `front_l`'s foot 0.197 m from its capsule.
//    `tests/unit/jumpseat-legs.test.ts` composes the frame a second way and
//    holds the two together.
//  - **No Coriolis, centrifugal or Euler term** from the chassis's own
//    rotation. On a 0.25 kg mass at 1 m, at the seat's angular rates, those are
//    small against a 6.96 N·m gravity torque.
//  - **The damper is integrated implicitly.** `c·dt/I` is 1.36, so an explicit
//    damper would overshoot and ring — a numerical artefact, not physics.
//    PhysX solves its joints implicitly too, so this is the closer reading.
//
// SIM LAYER: no three, no DOM, no wall clock, no randomness, no allocation in
// the hot path. Fixed dt only (D4).

import { JUMPSEAT } from '@/generated/constants.generated'
import { GRAVITY } from './constants'
import { rotateVec3 } from './math/quat'
import { RAD_PER_DEG } from './math/scalar'
import { type Vec3, v3 } from './math/vec3'
import type { RigidBody } from './rigidbody'
import { type HeightField, highestGroundUnder } from './terrain/height-field'

/**
 * OQ-6, as one number: how many of `JointSpring.spring`'s own units there are
 * in one RADIAN of hinge error.
 *
 * `1` is the per-radian reading, which is what this port ships and what the
 * header argues for from four independent directions. The alternative is
 * `180 / Math.PI` — the per-degree reading — and it is one assignment away.
 * `tests/unit/jumpseat-legs.test.ts` pins today's answer and measures what the
 * other one would give, so the day a Unity 5.4 runtime settles it the change is
 * a constant and a number in a test, not a rewrite.
 *
 * Hard rule 3: this is not a value out of the Unity project at all — it is a
 * unit convention of the ENGINE, in the same category as `terrain-collision`'s
 * `restitution: 0` (PhysX's built-in default material, which lives in the
 * engine and not in an asset). There is nothing for the extractor to read.
 */
export const LEG_SPRING_UNITS_PER_RADIAN = 1

/**
 * Below this, a leg's swing direction is too close to horizontal (or pointing
 * down) for it to hold the chassis up at all, and the inverse-dynamics division
 * would blow up. A numerical guard on a degenerate pose — an upside-down seat —
 * not a physical constant. The shipped legs sit at 0.87.
 */
const MIN_VERTICAL_SWING = 0.05

/** One leg's fixed geometry and tuning, all of it built from the sheet. */
export interface JumpSeatLegSpec {
  /** `back_l` / `back_r` / `front_l` / `front_r`, straight off the prefab. */
  readonly name: string
  /** The hinge, in ship-root space: `composedPosition` + |anchor| up the strut. */
  readonly pivot: Vec3
  /** Unit, ship-root, pivot -> foot at θ = 0. Points down and outboard. */
  readonly strut: Vec3
  /** Unit, ship-root, perpendicular to `strut`: the way the FOOT moves for +θ. */
  readonly swing: Vec3
  /**
   * Unit, ship-root: `strut × swing`, the hinge. Exported for the art, never
   * asserted on — see "the orientation lesson" in `docs/DEVIATIONS.md`.
   */
  readonly axis: Vec3
  /** Metres, pivot -> centre of mass. `|anchor|` = 1. */
  readonly comDistance: number
  /** Metres, pivot -> the capsule's bottom cap. `|anchor|` + height/2 = 2.52. */
  readonly contactDistance: number
  /** The capsule's radius, 0.16 — how far the contact sits below its cap. */
  readonly contactRadius: number
  /** kg. 0.25 on every leg. */
  readonly mass: number
  /** N·m per RADIAN of hinge error. `spring` × `LEG_SPRING_UNITS_PER_RADIAN`. */
  readonly springTorque: number
  /** N·m per rad/s. `damper` × `LEG_SPRING_UNITS_PER_RADIAN`. */
  readonly damperTorque: number
  /** Radians. `targetPosition` degrees: 0 on the back pair, -1° on the front. */
  readonly target: number
  /** kg·m², about the hinge. Capsule transverse + m·r². */
  readonly inertia: number
}

/** One leg's state. Four of these per seat — never module-level (trap 19). */
export interface JumpSeatLegState {
  /** Radians about `spec.axis`, zero at the authored pose. Negative = sagging. */
  angle: number
  /** rad/s. */
  rate: number
  /** The foot is on the ground this tick. */
  grounded: boolean
  /** Newtons this leg is holding the chassis up with. Zero when airborne. */
  load: number
}

export interface JumpSeatLegs {
  readonly specs: readonly JumpSeatLegSpec[]
  readonly legs: JumpSeatLegState[]
  /**
   * The chassis velocity at the END of the previous tick, so this tick can
   * measure the acceleration the legs actually felt.
   *
   * PER GEAR, never module-level. Trap 19 in one field: a shared "previous
   * velocity" would hand one seat's landing to another seat's legs, and with
   * one seat there is nobody to inherit from. `tests/unit/jumpseat-legs.test.ts`
   * steps a SECOND gear for every stateful behaviour in this file.
   */
  readonly lastVelocity: Vec3
  /** False until the first tick has recorded a velocity to difference against. */
  primed: boolean
  /** Newtons the four legs held the chassis up with, last tick. For the HUD. */
  totalLoad: number
}

// Volatile module-level scratch. Written, read and discarded inside ONE
// synchronous call — never stored, never read across calls. See the note on
// `lastVelocity` above for the state that must NOT live here.
const _pivotW = v3()
const _strutW = v3()
const _swingW = v3()
const _gEff = v3()

const NO_FIELDS: readonly HeightField[] = Object.freeze([]) as readonly HeightField[]

/**
 * A solid capsule's moment of inertia about a transverse axis through its own
 * centre of mass — cylinder plus two hemispheres, uniform density.
 *
 * DEV-027: this is the inertia OF one leg, ABOUT an axis through the capsule's
 * centre and PERPENDICULAR to the capsule's long axis. That is the right one
 * because `axis` (1,0,0) and the capsule's `direction: 1` (y) are perpendicular
 * in the leg's own frame, so the hinge is transverse to the strut. For the
 * shipped 0.25 kg / r 0.16 / h 3.04 leg it is 0.18118 kg·m², against 0.19253
 * for the thin-rod approximation — 6 % apart, which is why the capsule is done
 * properly rather than waved at.
 */
export const capsuleTransverseInertia = (mass: number, radius: number, height: number): number => {
  const cylinder = Math.max(0, height - 2 * radius)
  const vCylinder = Math.PI * radius * radius * cylinder
  const vCaps = (4 / 3) * Math.PI * radius * radius * radius
  const total = vCylinder + vCaps
  if (total <= 0) return 0
  const mCylinder = (mass * vCylinder) / total
  const mCap = (mass * vCaps) / total / 2 // one hemisphere
  const iCylinder = (mCylinder * (3 * radius * radius + cylinder * cylinder)) / 12
  // A hemisphere's inertia about a diameter of its flat face is (2/5)m r², its
  // centre of mass sits 3r/8 in from that face, and the face is h_cyl/2 from
  // the capsule's centre. Parallel axis, twice, in that order.
  const offset = 3 * radius * 0.125
  const iCapAboutOwnCom = (2 / 5) * mCap * radius * radius - mCap * offset * offset
  const capLever = cylinder / 2 + offset
  const iCap = iCapAboutOwnCom + mCap * capLever * capLever
  return iCylinder + 2 * iCap
}

const normalized = (x: number, y: number, z: number): Vec3 => {
  const l = Math.hypot(x, y, z)
  return l > 0 ? v3(x / l, y / l, z / l) : v3(0, -1, 0)
}

/**
 * Build the four leg specs from the sheet.
 *
 * ── Where each number comes from ──────────────────────────────────────────
 *
 *  - the CENTRE OF MASS is `legs[i].composedPosition`. The leg's only enabled
 *    collider is a capsule whose `center` is (0,0,0) in the leg's own frame, so
 *    Unity's computed centre of mass is the leg's origin and nothing else.
 *  - the FRAME is the leg capsule's own, composed to the prefab root
 *    (`composedFromShipRoot.rotation`). The capsule is the one ENABLED
 *    collider on the leg and the one 2016 stood the seat on; the `foot_00`
 *    boxes under each leg are all `m_Enabled: 0` (DEV-530).
 *  - the PIVOT is the HingeJoint's `anchor` in that frame, (0, 1, 0): a metre
 *    up the leg from its centre of mass.
 *  - the FOOT is the capsule's bottom end, `center` less `height / 2` along
 *    its `direction` (y): 1.52 m down the leg, 2.52 m from the pivot.
 *  - the STRUT is the unit vector from the pivot to the foot.
 *  - the SWING is the way a turn about the joint's `axis` in that frame
 *    carries the foot, signed so +θ lifts it; the hinge is `strut × swing`,
 *    which is 2016's axis up to that sign.
 */
export const createJumpSeatLegSpecs = (
  springUnitsPerRadian: number = LEG_SPRING_UNITS_PER_RADIAN,
): JumpSeatLegSpec[] =>
  JUMPSEAT.legs.map((leg) => {
    const com = leg.composedPosition
    // The leg's own enabled capsule: the one collider 2016 stood the seat on.
    // Same GameObject as the HingeJoint's rigidbody, so its composed frame IS
    // the leg's frame (`JUMPSEAT.art.legFrames` carries the same rotation, and
    // `jumpseat-legs.test.ts` holds the two equal). DEV-530: this used to aim
    // the strut at the lowest collider under the leg instead — a DISABLED
    // `foot_00` box, a different size on every leg — which stood `front_l`
    // 17-20 cm lower than the other three.
    const capsule = JUMPSEAT.colliders.find(
      (c) => c.name === leg.name && c.parentPath === leg.parentPath && c.enabled,
    )
    if (!capsule || capsule.shape.kind !== 'CapsuleCollider') {
      throw new Error(`jumpseat-legs: no enabled capsule on leg '${leg.name}'`)
    }
    const radius = 'radius' in capsule.effective ? capsule.effective.radius : 0
    const height = 'height' in capsule.effective ? capsule.effective.height : 0
    const frame = capsule.composedFromShipRoot.rotation

    // Everything below is a point or a direction in the LEG's own frame, carried
    // out to ship-root by that frame: the hinge `anchor`, the hinge `axis`, and
    // the capsule's bottom end (its `center` less half its height along its
    // `direction` axis — y on all four, so down the leg's own -Y).
    const local = (x: number, y: number, z: number): Vec3 => rotateVec3(v3(), frame, v3(x, y, z))
    const anchor = local(leg.anchor.x, leg.anchor.y, leg.anchor.z)
    const pivot = v3(com.x + anchor.x, com.y + anchor.y, com.z + anchor.z)
    const c0 = capsule.shape.center
    const capEnd = local(c0.x, c0.y - height / 2, c0.z)
    const toFootX = com.x + capEnd.x - pivot.x
    const toFootY = com.y + capEnd.y - pivot.y
    const toFootZ = com.z + capEnd.z - pivot.z
    const strut = normalized(toFootX, toFootY, toFootZ)
    const comDistance = Math.hypot(leg.anchor.x, leg.anchor.y, leg.anchor.z)

    // The swing is the way a turn about 2016's OWN hinge carries the foot:
    // `hinge × strut`, square to both. Its sign is chosen so +θ LIFTS the foot
    // on all four legs, which is the sim's convention and the art's
    // (`game/jumpseat-art.ts` reads the sign back off `swing`).
    const hinge = local(leg.axis.x, leg.axis.y, leg.axis.z)
    let swing = normalized(
      hinge.y * strut.z - hinge.z * strut.y,
      hinge.z * strut.x - hinge.x * strut.z,
      hinge.x * strut.y - hinge.y * strut.x,
    )
    if (swing.y < 0) swing = v3(-swing.x, -swing.y, -swing.z)
    // `axis = strut × swing` is the hinge such that `strut × sin θ` carries the
    // foot along `swing` — i.e. positive θ LIFTS the foot, on all four legs. It
    // is 2016's hinge, up to that sign.
    const axis = normalized(
      strut.y * swing.z - strut.z * swing.y,
      strut.z * swing.x - strut.x * swing.z,
      strut.x * swing.y - strut.y * swing.x,
    )

    const mass = leg.rigidbody.mass
    return {
      name: leg.name,
      pivot,
      strut,
      swing,
      axis,
      comDistance,
      contactDistance: Math.hypot(toFootX, toFootY, toFootZ),
      contactRadius: radius,
      mass,
      springTorque: leg.spring.spring * springUnitsPerRadian,
      damperTorque: leg.spring.damper * springUnitsPerRadian,
      target: leg.spring.targetPosition * RAD_PER_DEG,
      inertia: capsuleTransverseInertia(mass, radius, height) + mass * comDistance * comDistance,
    }
  })

/**
 * One seat's landing gear, at rest in the authored pose.
 *
 * Starting every leg at `angle: 0` rather than at its sagged equilibrium is
 * deliberate — a seat that spawns already drooping hides a spring that does not
 * work. The first second of flight settles them, and the test measures it.
 */
export const createJumpSeatLegs = (specs?: readonly JumpSeatLegSpec[]): JumpSeatLegs => ({
  specs: specs ?? createJumpSeatLegSpecs(),
  legs: [0, 1, 2, 3].map(() => ({ angle: 0, rate: 0, grounded: false, load: 0 })),
  lastVelocity: v3(),
  primed: false,
  totalLoad: 0,
})

/**
 * Put one seat's gear back in the authored pose. For a respawn, which in 2016
 * reloaded the scene and therefore built a fresh prefab.
 *
 * `primed` goes back to false as well, and that is the load-bearing half: a
 * seat teleported to a marker has a velocity discontinuity, and differencing
 * across it would hand the legs an acceleration of several thousand g.
 */
export const resetJumpSeatLegs = (gear: JumpSeatLegs): void => {
  for (const leg of gear.legs) {
    leg.angle = 0
    leg.rate = 0
    leg.grounded = false
    leg.load = 0
  }
  gear.lastVelocity.x = 0
  gear.lastVelocity.y = 0
  gear.lastVelocity.z = 0
  gear.primed = false
  gear.totalLoad = 0
}

/**
 * Where one foot is, in the SHIP's own frame, at a given hinge angle.
 *
 * The foot the game can hit is the capsule's bottom CAP, `contactDistance` down
 * the strut; the surface it stands on is `contactRadius` below that.
 *
 * **The render layer draws each leg between `spec.pivot` and this point** rather
 * than rotating a mesh by `angle` itself. That is the orientation lesson taken
 * literally: a pair of endpoints is the same geometry in either handedness, so
 * the z-flip into three space cannot silently swing a leg the wrong way, and
 * the test that the drawn foot is the simulated foot is a DISTANCE. Two things
 * that must stay equal are the same function. *(§5 of "The orientation
 * lesson", `docs/DEVIATIONS.md`.)*
 */
export const legFootLocal = (out: Vec3, spec: JumpSeatLegSpec, angle: number): Vec3 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const d = spec.contactDistance
  out.x = spec.pivot.x + d * (spec.strut.x * c + spec.swing.x * s)
  out.y = spec.pivot.y + d * (spec.strut.y * c + spec.swing.y * s)
  out.z = spec.pivot.z + d * (spec.strut.z * c + spec.swing.z * s)
  return out
}

/** The same point in world space. */
export const legFootWorld = (
  out: Vec3,
  spec: JumpSeatLegSpec,
  angle: number,
  body: RigidBody,
): Vec3 => {
  legFootLocal(out, spec, angle)
  rotateVec3(out, body.orientation, out)
  out.x += body.position.x
  out.y += body.position.y
  out.z += body.position.z
  return out
}

/**
 * Advance one seat's four legs by exactly one fixed tick, and accumulate what
 * they are holding the chassis up with into `body.force`.
 *
 * Call it AFTER the thrust and torque have been accumulated and BEFORE
 * `integrate` — the reaction has to be in the accumulator the same tick it is
 * generated, or the cushion arrives one tick after the impact it is cushioning.
 *
 * Returns the total upward force, newtons.
 *
 * `gravity` is the SEAT's, which `stepJumpSeat` passes as `seat.gravity`
 * (DEV-384): a leg is part of the vehicle, so it falls with the chassis. Fed
 * the world's while the chassis fell at 1.4 of it, `g_eff` in free fall would
 * point UP and the legs would float above their hinges.
 */
export const stepJumpSeatLegs = (
  gear: JumpSeatLegs,
  body: RigidBody,
  fields: readonly HeightField[] = NO_FIELDS,
  dt: number,
  gravity: Readonly<Vec3> = GRAVITY,
): number => {
  // What the chassis actually did last tick, drag, hover impulses, collision
  // depenetration and all. `g_eff` is what a mass riding it feels.
  if (gear.primed) {
    _gEff.x = gravity.x - (body.velocity.x - gear.lastVelocity.x) / dt
    _gEff.y = gravity.y - (body.velocity.y - gear.lastVelocity.y) / dt
    _gEff.z = gravity.z - (body.velocity.z - gear.lastVelocity.z) / dt
  } else {
    _gEff.x = gravity.x
    _gEff.y = gravity.y
    _gEff.z = gravity.z
    gear.primed = true
  }
  gear.lastVelocity.x = body.velocity.x
  gear.lastVelocity.y = body.velocity.y
  gear.lastVelocity.z = body.velocity.z

  let total = 0
  for (let i = 0; i < gear.specs.length; i++) {
    const spec = gear.specs[i] as JumpSeatLegSpec
    const leg = gear.legs[i] as JumpSeatLegState
    const startAngle = leg.angle

    rotateVec3(_pivotW, body.orientation, spec.pivot)
    rotateVec3(_strutW, body.orientation, spec.strut)
    rotateVec3(_swingW, body.orientation, spec.swing)
    const px = body.position.x + _pivotW.x
    const py = body.position.y + _pivotW.y
    const pz = body.position.z + _pivotW.z

    // ── free swing ───────────────────────────────────────────────────────
    //
    // τ = r·(m·g_eff · ŝ(θ)) with ŝ(θ) = -strut·sin θ + swing·cos θ, which is
    // the direction the CENTRE OF MASS travels for +θ. The damper is folded
    // into the implicit denominator rather than added as a torque.
    let c = Math.cos(leg.angle)
    let s = Math.sin(leg.angle)
    let sx = -_strutW.x * s + _swingW.x * c
    let sy = -_strutW.y * s + _swingW.y * c
    let sz = -_strutW.z * s + _swingW.z * c
    const gravityTorque =
      spec.comDistance * spec.mass * (_gEff.x * sx + _gEff.y * sy + _gEff.z * sz)
    const springTorque = -spec.springTorque * (leg.angle - spec.target)
    const rate =
      (leg.rate + ((springTorque + gravityTorque) / spec.inertia) * dt) /
      (1 + (spec.damperTorque / spec.inertia) * dt)
    leg.rate = rate
    leg.angle += rate * dt

    // ── the ground ───────────────────────────────────────────────────────
    //
    // Foot height as a function of θ is `py + d·(A·cos θ + B·sin θ)`, so the
    // angle that puts it on a given surface is a closed form — no iteration,
    // and no invented contact stiffness.
    leg.grounded = false
    leg.load = 0
    c = Math.cos(leg.angle)
    s = Math.sin(leg.angle)
    const d = spec.contactDistance
    const footX = px + d * (_strutW.x * c + _swingW.x * s)
    const footZ = pz + d * (_strutW.z * c + _swingW.z * s)
    const footY = py + d * (_strutW.y * c + _swingW.y * s)
    // A foot UNDER a floating pad does not stand on it (DEV-383, `belowField`).
    const ground = highestGroundUnder(fields, footX, footZ, footY + spec.contactRadius)
    if (Number.isFinite(ground)) {
      const surface = ground + spec.contactRadius
      if (footY < surface) {
        const a = _strutW.y
        const b = _swingW.y
        const amp = Math.hypot(a, b)
        const want = (surface - py) / d
        const phase = Math.atan2(b, a)
        // `phase` is where the foot is highest. Coming up from below, the root
        // on the near side of it is the one the leg reaches first.
        const contact = amp > 0 && Math.abs(want) < amp ? phase - Math.acos(want / amp) : phase
        if (contact > leg.angle) {
          leg.angle = contact
          // The rate the leg ACTUALLY turned at this tick, which is what the
          // damper is owed — including the swing it had before it touched.
          leg.rate = (contact - startAngle) / dt
          leg.grounded = true
        }
      }
    }

    if (leg.grounded) {
      // Inverse dynamics at the pinned angle: the vertical force at the contact
      // that balances spring + damper + the leg's own weight about the hinge.
      c = Math.cos(leg.angle)
      s = Math.sin(leg.angle)
      sx = -_strutW.x * s + _swingW.x * c
      sy = -_strutW.y * s + _swingW.y * c
      sz = -_strutW.z * s + _swingW.z * c
      if (sy > MIN_VERTICAL_SWING) {
        const spring = -spec.springTorque * (leg.angle - spec.target)
        const damper = -spec.damperTorque * leg.rate
        const weight = spec.comDistance * spec.mass * (_gEff.x * sx + _gEff.y * sy + _gEff.z * sz)
        // A leg can push the seat up. It can never pull it down — the foot is
        // standing on the ground, not bolted to it.
        const force = -(spring + damper + weight) / (d * sy)
        if (force > 0) {
          leg.load = force
          total += force
        }
      }
    }
  }

  gear.totalLoad = total
  // Applied at the hinges, upward, with NO torque: see the header. An inertia
  // tensor of 1 turns a newton-metre into hundreds of rad/s².
  body.force.y += total
  return total
}

/**
 * The static droop of one leg, radians, under an effective gravity of `g`.
 *
 * DERIVED, and held to the DEV-027 standard: this is the hinge ANGLE at which
 * the spring's restoring torque exactly cancels the gravity torque on the leg's
 * own 0.25 kg, with the leg at rest and nothing touching the foot. It is
 * measured from the AUTHORED pose, so the front pair's -1° target is on top of
 * it.
 *
 *     k·(θ - target) = r·m·g·ŝ_y      ->   θ = target - r·m·g·ŝ_y / k
 *
 * Small-angle: it uses ŝ at θ = 0 rather than at θ itself, so it over-states
 * the droop by **0.86 %** at the shipped angle — -0.9012° against the model's
 * measured -0.8935°. The measured test does NOT use this: it steps the model
 * and reads the angle off, precisely so the two are free to disagree, and the
 * disagreement is the small-angle term rather than a bug in either.
 */
export const legStaticSag = (spec: JumpSeatLegSpec, g: number = Math.abs(GRAVITY.y)): number =>
  spec.target - (spec.comDistance * spec.mass * g * spec.swing.y) / spec.springTorque
