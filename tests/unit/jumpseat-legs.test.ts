// tests/unit/jumpseat-legs.test.ts — the JumpSeat's four springy legs, measured.
//
// Matt, 2026-09-12: *"jumpseat's legs: these were 'springy legs', so when the
// jumpseat was in the air - the legs would sag a bit. and they'd cushion the
// landings."* Two claims, and this file is the two measurements.
//
// ── Every assertion is a geometry, a number of degrees, or a number of m/s² ──
//
// There is not one quaternion assertion in this file, on purpose. This project
// has shipped four orientation bugs, three of them caught by Matt from a
// screenshot with 400+ green tests behind them, and the reason is that a
// rotation assertion is your belief written twice. So the leg geometry is
// checked by asking *where does the end of the leg END UP* — which quadrant,
// which side of its own hinge, how far from the foot the prefab authored — and
// every one of those is true or false independently of what anyone believed.
// See "The orientation lesson" in `docs/DEVIATIONS.md`.
//
// ── The units guard ─────────────────────────────────────────────────────────
//
// Unity's `JointSpring.spring` is a torque per DEGREE or per RADIAN of hinge
// error and the YAML does not say which; `sim/jumpseat-legs.ts`'s header argues
// per radian from four directions and ships it as ONE constant. The two
// readings are 57.3x apart, which is the difference between legs that work and
// legs that cannot move — so `the spring's units` below measures BOTH, rather
// than pinning the one we chose and calling it verified.
//
// ── Trap 19 ─────────────────────────────────────────────────────────────────
//
// Four legs on one seat, four scratch vectors in one module, and a "previous
// velocity" that has to be per-gear: this file is exactly the shape `ai-racer`
// was when one shared `HoverJetInput` flew a finished racer into the sea. Every
// stateful behaviour below is stepped with a SECOND gear alongside, because
// with one object there is nobody to inherit from.

import { describe, expect, it } from 'vitest'
import { JUMPSEAT } from '@/generated/constants.generated'
import { FIXED_DT, GRAVITY } from '@/sim/constants'
import { createJumpSeat, type JumpSeat, noJumpSeatInput, stepJumpSeat } from '@/sim/jumpseat'
import {
  capsuleTransverseInertia,
  createJumpSeatLegSpecs,
  createJumpSeatLegs,
  type JumpSeatLegSpec,
  LEG_SPRING_UNITS_PER_RADIAN,
  legFootLocal,
  legFootWorld,
  legStaticSag,
  resetJumpSeatLegs,
  stepJumpSeatLegs,
} from '@/sim/jumpseat-legs'
import { mul, rotateVec3 } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { createRigidBody } from '@/sim/rigidbody'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  createTerrainCollision,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'

// ── ground ────────────────────────────────────────────────────────────────

const flatMap = (g: number): MapSampler =>
  ({
    width: 256,
    height: 256,
    sample(_u: number, _v: number, out: Rgb): Rgb {
      out.r = g
      out.g = g
      out.b = g
      return out
    },
  }) as unknown as MapSampler

const PARAMS = {
  terrainSize: 1024,
  terrainHeight: 100,
  baseResolution: 8,
  chunkSize: 256,
  randomOffset: 0,
  seed: 1,
} as unknown as FacetedTerrainParams

/** Flat ground at y = 50, over a 1 km square. */
const FLAT: HeightField = buildHeightField(flatMap(0.5), PARAMS, {
  position: [0, 0, 0],
  scale: [1, 1, 1],
})
const GROUND = 50
const NO_GROUND: readonly HeightField[] = []

/**
 * The full ground rule the flight seam applies, copied from
 * `game/jumpseat-flight.ts` so the A/B below measures what the PLAYER feels
 * rather than what the flight model feels on its own.
 */
const COLLISION: TerrainCollisionSpec = {
  hull: hullFromColliders(
    JUMPSEAT.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
  ),
  restitution: 0,
  friction: 0.6,
  flashSeconds: 0.3,
  flashAngularDrag: 3,
}

// ── helpers ───────────────────────────────────────────────────────────────

const DEG = 180 / Math.PI
const SPECS = createJumpSeatLegSpecs()
const legNamed = (name: string): JumpSeatLegSpec => {
  const spec = SPECS.find((s) => s.name === name)
  if (!spec) throw new Error(`no leg ${name}`)
  return spec
}

const live = (s: JumpSeat): JumpSeat => {
  s.live = true
  return s
}
const at = (s: JumpSeat, x: number, y: number, z: number): JumpSeat => {
  s.body.position.x = x
  s.body.position.y = y
  s.body.position.z = z
  return s
}

/**
 * Hold a chassis at a KNOWN acceleration and let the legs settle against it.
 *
 * This drives the body by hand rather than flying it, which is the only way to
 * separate the two things the sag depends on: gravity, and what the chassis is
 * doing. A seat flown to terminal velocity is at a = 0 whether it is climbing
 * or falling, so "the legs sag more under thrust" is not a claim a flown test
 * can even make.
 */
const settleAt = (accel: number, ticks = 600, specs: readonly JumpSeatLegSpec[] = SPECS) => {
  const gear = createJumpSeatLegs(specs)
  const body = createRigidBody({ mass: JUMPSEAT.rigidbody.mass })
  body.position.y = 1000
  for (let i = 0; i < ticks; i++) {
    if (i > 0) body.velocity.y += accel * FIXED_DT
    stepJumpSeatLegs(gear, body, NO_GROUND, FIXED_DT)
  }
  return gear
}

/** Vertical drop of one foot below its authored pose, metres. */
const footDrop = (spec: JumpSeatLegSpec, angle: number): number => {
  const rest = legFootLocal(v3(), spec, 0)
  const now = legFootLocal(v3(), spec, angle)
  return rest.y - now.y
}

const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

/** Degrees between two directions of any length; `asLine` ignores their sense. */
const angleBetween = (a: Vec3, b: Vec3, asLine: boolean): number => {
  const c = dot(a, b) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z))
  return Math.acos(Math.min(1, asLine ? Math.abs(c) : c)) * DEG
}

interface DropResult {
  peak: number
  lowest: number
  vImpact: number
  settled: number
  load: number
}

/**
 * Drop a seat from `height` onto flat ground and report what the BODY felt.
 *
 * `peak` is the largest upward acceleration of the chassis over one fixed tick,
 * measured from its own velocity — so it counts the terrain collision's
 * velocity kill, which is not a force and which a force-derived number would
 * miss entirely. That is the quantity a landing gear exists to reduce.
 */
const drop = (withLegs: boolean, height: number, ticks: number): DropResult => {
  const seat = live(at(createJumpSeat(), 500, GROUND + height, 500))
  if (!withLegs) seat.legs = null
  const collision = createTerrainCollision()
  let peak = 0
  let lowest = Number.POSITIVE_INFINITY
  let vImpact = 0
  let prev = seat.body.velocity.y
  for (let i = 0; i < ticks; i++) {
    const before = seat.body.velocity.y
    stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
    stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
    const a = (seat.body.velocity.y - prev) / FIXED_DT
    prev = seat.body.velocity.y
    const h = seat.body.position.y - GROUND
    if (h < lowest) lowest = h
    if (i > 5 && a > peak) peak = a
    if (vImpact === 0 && h < 2.5) vImpact = before
  }
  return {
    peak,
    lowest,
    vImpact,
    settled: seat.body.position.y - GROUND,
    load: seat.legs?.totalLoad ?? 0,
  }
}

// ── the constants ─────────────────────────────────────────────────────────

describe('the legs come off the PREFAB', () => {
  it('is four HingeJoints at 450/48, with the limits switched OFF', () => {
    expect(JUMPSEAT.legs).toHaveLength(4)
    for (const leg of JUMPSEAT.legs) {
      expect(leg.spring.spring).toBe(450)
      expect(leg.spring.damper).toBe(48)
      expect(leg.useSpring).toBe(true)
      expect(leg.useMotor).toBe(false)
      // `m_UseLimits: 0`, so -35..80 and -35..150 are INERT and this port does
      // not implement them. They are not useless — they are the evidence that
      // somebody expected these legs to travel tens of degrees, which is the
      // first of the four arguments for the per-radian spring reading.
      expect(leg.useLimits).toBe(false)
      expect(leg.rigidbody.mass).toBe(0.25)
      expect(leg.rigidbody.useGravity).toBe(true)
      expect(leg.rigidbody.drag).toBe(0)
      expect(leg.rigidbody.angularDrag).toBe(0)
    }
    // Inert or not, they are what they are.
    expect(JUMPSEAT.legs.filter((l) => l.limits.max === 80)).toHaveLength(2)
    expect(JUMPSEAT.legs.filter((l) => l.limits.max === 150)).toHaveLength(2)
  })

  it('reads every leg constant from the sheet, none of them typed in', () => {
    for (const [i, spec] of SPECS.entries()) {
      const leg = JUMPSEAT.legs[i]
      if (!leg) throw new Error('leg lost')
      expect(spec.name).toBe(leg.name)
      expect(spec.mass).toBe(leg.rigidbody.mass)
      expect(spec.springTorque).toBe(leg.spring.spring * LEG_SPRING_UNITS_PER_RADIAN)
      expect(spec.damperTorque).toBe(leg.spring.damper * LEG_SPRING_UNITS_PER_RADIAN)
      expect(spec.target * DEG).toBeCloseTo(leg.spring.targetPosition, 9)
      // `|anchor|` is the pivot -> centre-of-mass lever, and it is 1 m because
      // the anchor is (0,1,0) and the leg's only enabled collider is a capsule
      // centred on its own origin.
      expect(spec.comDistance).toBeCloseTo(1, 9)
    }
  })

  it('keeps the authored front/back target asymmetry, which is a STANCE', () => {
    // 0° on the back pair and -1° on the front. Normalising that away would
    // turn a deliberate nose-up rake into four identical droops.
    expect(legNamed('back_l').target).toBe(0)
    expect(legNamed('back_r').target).toBe(0)
    expect(legNamed('front_l').target * DEG).toBeCloseTo(-1, 9)
    expect(legNamed('front_r').target * DEG).toBeCloseTo(-1, 9)
  })

  it('takes its inertia from the capsule the prefab actually enables', () => {
    // DEV-027: this is the inertia OF one leg ABOUT its hinge, an axis through
    // the pivot perpendicular to the capsule's long axis. Two independent
    // bounds rather than a restatement of the formula: it has to exceed the
    // point-mass m·r², and it has to sit near — but under — the thin-rod
    // approximation, which over-counts a capsule of this aspect ratio.
    const spec = legNamed('back_l')
    const m = 0.25
    const rod = (m * 3.04 * 3.04) / 12
    expect(spec.inertia).toBeGreaterThan(m * 1 * 1)
    expect(spec.inertia).toBeLessThan(m * 1 * 1 + rod)
    expect(spec.inertia).toBeCloseTo(m + capsuleTransverseInertia(m, 0.16, 3.04), 12)
    // And it is sensitive to the geometry, so a capsule read as a point would
    // not pass: halving the length takes a quarter off the transverse term.
    expect(capsuleTransverseInertia(m, 0.16, 1.52)).toBeLessThan(
      capsuleTransverseInertia(m, 0.16, 3.04) / 3,
    )
  })
})

// ── geometry: where the leg ENDS UP ───────────────────────────────────────

describe('the leg geometry', () => {
  it('rakes each leg out into its OWN quadrant, and downward', () => {
    // The mirror guard, in the shape that caught the turn indicator. A mirror
    // in x, a wrong-handed import or a mis-composed parent all put at least one
    // strut in somebody else's quadrant — and a rectangle of four legs is
    // exactly the kind of symmetric object that hides it from everything else.
    for (const spec of SPECS) {
      const leg = JUMPSEAT.legs.find((l) => l.name === spec.name)
      if (!leg) throw new Error('leg lost')
      expect(Math.sign(spec.strut.x)).toBe(Math.sign(leg.composedPosition.x))
      expect(Math.sign(spec.strut.z)).toBe(Math.sign(leg.composedPosition.z))
      expect(spec.strut.y).toBeLessThan(-0.4)
    }
  })

  it('hangs every foot outboard of and below its own hinge', () => {
    // A landing gear widens downward. The hinges are tucked under the chassis
    // near y = 0 and the feet are out at ±2.2 m and down at −1.2 m, so the
    // three points (hinge, leg body, foot) march outward and down in order.
    for (const spec of SPECS) {
      const leg = JUMPSEAT.legs.find((l) => l.name === spec.name)
      if (!leg) throw new Error('leg lost')
      const com = leg.composedPosition
      const foot = legFootLocal(v3(), spec, 0)
      expect(Math.abs(spec.pivot.x)).toBeLessThan(Math.abs(com.x))
      expect(Math.abs(com.x)).toBeLessThan(Math.abs(foot.x))
      expect(spec.pivot.y).toBeGreaterThan(com.y)
      expect(com.y).toBeGreaterThan(foot.y)
      // The hinges sit within a few cm of the chassis waterline; the feet are
      // more than a metre below it. That is the travel the gear has.
      expect(Math.abs(spec.pivot.y)).toBeLessThan(0.25)
      expect(foot.y).toBeLessThan(-1)
    }
  })

  it('puts the hinge square across the strut, and lifts the foot for +θ', () => {
    // Two facts a wrong axis breaks, and neither is a rotation: the hinge is
    // perpendicular to the leg it turns (a strut whose hinge ran ALONG it would
    // not swing at all), and the sign convention is the same on all four legs.
    for (const spec of SPECS) {
      expect(Math.abs(dot(spec.axis, spec.strut))).toBeLessThan(1e-9)
      expect(Math.abs(dot(spec.axis, spec.swing))).toBeLessThan(1e-9)
      expect(footDrop(spec, 0.1)).toBeLessThan(-0.15) // +θ raises it
      expect(footDrop(spec, -0.1)).toBeGreaterThan(0.15) // −θ drops it
      // The swing is mostly vertical — which is what makes a leg able to hold
      // the chassis up at all, and the term the whole cushion scales with.
      expect(spec.swing.y).toBeGreaterThan(0.75)
    }
  })

  it('reaches the FOOT the prefab authored, 2.5 m down the strut', () => {
    // The turn-indicator check, on this prefab: measure the strut against
    // geometry the sim does not read — the art's `legFrames` row, the leg
    // rigidbody's frame as the ART extractor composes it — and ask where the
    // capsule's bottom end lands in it. A wrong strut misses by metres; a strut
    // aimed at a disabled `foot_00` box (the pre-DEV-530 sim) missed `front_l`'s
    // by 0.197 m.
    for (const spec of SPECS) {
      const frame = JUMPSEAT.art.legFrames.find((f) => f.name === spec.name)
      if (!frame) throw new Error(`no frame for ${spec.name}`)
      expect(frame.live).toBe(true)
      const p = frame.composed.position
      const end = rotateVec3(v3(), frame.composed.rotation, v3(0, -3.04 / 2, 0))
      const foot = legFootLocal(v3(), spec, 0)
      // 2.52 m from the hinge: |anchor| + h/2. To 1e-6, the sheet's rounding.
      expect(spec.contactDistance).toBeCloseTo(1 + 3.04 / 2, 6)
      const miss = Math.hypot(foot.x - p.x - end.x, foot.y - p.y - end.y, foot.z - p.z - end.z)
      expect(miss, spec.name).toBeLessThan(1e-5)
    }
  })

  it('stands the seat LEVEL: four feet at one height, mirror images (DEV-530)', () => {
    // Matt, 2026-09-29, of `front_l` sitting 17-20 cm low: *"fix plz"*. The
    // prefab's four leg frames are one leg mirrored across x and yawed across
    // z, so the four feet at rest are at ONE height and mirror in x. The two
    // pairs differ in z only by where 2016 hung their bodies (1.56 against
    // 1.48). Before DEV-530 the heights were -1.158 / -1.154 / -1.359 / -1.188.
    const feet = SPECS.map((s) => legFootLocal(v3(), s, 0))
    const ys = feet.map((f) => f.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-5)
    expect(ys[0] as number).toBeCloseTo(-1.1955, 3)
    const [bl, br, fl, fr] = feet as [Vec3, Vec3, Vec3, Vec3]
    expect(bl.x + br.x).toBeCloseTo(0, 5)
    expect(fl.x + fr.x).toBeCloseTo(0, 5)
    expect(Math.abs(bl.x) - Math.abs(fl.x)).toBeCloseTo(0, 5)
    expect(fl.z + bl.z).toBeCloseTo(1.56 - 1.48, 5)
  })

  it('stands on a footprint LONGER than it is wide, 5.29 m by 4.40 m', () => {
    // `jumpseat.test.ts` asserts the 3.00 x 3.04 rectangle on the leg BODIES.
    // The feet are the part that touches the world and they are 1.45x further
    // out than the bodies, so the footprint has to grow with them.
    //
    // The assertion is an ASPECT RATIO, which is the form the gate guard takes
    // and for the same reason: the cage is 19.0 x 30.1 unrolled and 30.1 x 19.0
    // rolled, and it cannot be both. A gear yawed 90° by a bad composition puts
    // the long axis across the ship, and nothing about four legs in a rectangle
    // would otherwise say which way round they go.
    const feet = SPECS.map((s) => legFootLocal(v3(), s, 0))
    const xs = feet.map((f) => f.x)
    const zs = feet.map((f) => f.z)
    const beam = Math.max(...xs) - Math.min(...xs)
    const wheelbase = Math.max(...zs) - Math.min(...zs)
    // DEV-530: 4.402 by 5.288 on the capsules' own frames; 4.449 by 5.336
    // while the struts were aimed at the disabled foot boxes.
    expect(beam).toBeCloseTo(4.402, 2)
    expect(wheelbase).toBeCloseTo(5.288, 2)
    expect(wheelbase).toBeGreaterThan(beam)
    // And each foot is further out in x than the leg body it hangs off — the
    // gear splays, it does not drop straight down.
    for (const [i, foot] of feet.entries()) {
      const com = JUMPSEAT.legs[i]?.composedPosition
      if (!com) throw new Error('leg lost')
      expect(Math.abs(foot.x) / Math.abs(com.x)).toBeGreaterThan(1.4)
    }
  })
})

// ── 1. SAG IN THE AIR, measured ───────────────────────────────────────────

describe('they sag in the air', () => {
  it('settles the back pair 0.88° down and the front pair 1.87° down', () => {
    // MEASURED: the legs are stepped against a chassis held at zero
    // acceleration, and the angle is read off. `legStaticSag` is the closed
    // form and it is NOT what this asserts — the two are allowed to disagree,
    // and the 1 % they do disagree by is the small-angle term the formula drops.
    const gear = settleAt(0)
    const back = gear.legs[0]
    const front = gear.legs[2]
    if (!back || !front) throw new Error('legs lost')

    // DEV-530: -0.8786 and -1.8696 on the capsules' own frames (-0.8935 and
    // -1.7967 on the struts the foot boxes aimed).
    expect(back.angle * DEG).toBeCloseTo(-0.8786, 3)
    expect(front.angle * DEG).toBeCloseTo(-1.8696, 3)
    expect(back.angle * DEG).toBeCloseTo(legStaticSag(legNamed('back_l')) * DEG, 1)

    // What that is worth as a DISTANCE, which is the thing Matt would have
    // seen: 3.4 cm at the back feet, 7.1 cm at the front. Small, and real.
    expect(footDrop(legNamed('back_l'), back.angle)).toBeCloseTo(0.0335, 3)
    expect(footDrop(legNamed('front_l'), front.angle)).toBeCloseTo(0.0709, 3)
  })

  it('hangs the FRONT feet a degree lower — the authored -1°, not noise', () => {
    // 0.991°, not exactly 1: the spring and the leg's weight balance at a
    // slightly different point on the arc once the target has moved it. Since
    // DEV-530 the four legs are one leg mirrored (swing.y 0.870 on all four;
    // it was 0.801 on the front pair against 0.885 while the struts were aimed
    // at the foot boxes, and the gap was 0.903°), so take the target out and
    // the gap is not small, it is ZERO.
    const gear = settleAt(0)
    const back = gear.legs[0]?.angle ?? 0
    const front = gear.legs[2]?.angle ?? 0
    expect((back - front) * DEG).toBeCloseTo(0.991, 2)

    const untargeted = settleAt(
      0,
      600,
      SPECS.map((s) => ({ ...s, target: 0 })),
    )
    const gap = ((untargeted.legs[0]?.angle ?? 0) - (untargeted.legs[2]?.angle ?? 0)) * DEG
    expect(Math.abs(gap)).toBeLessThan(1e-6)
  })

  it('FLOATS in free fall, because the legs are falling too', () => {
    // The discriminating one. A leg driven by world gravity sags identically
    // whatever the chassis is doing; a leg driven by gravity MINUS the chassis's
    // own acceleration goes slack the moment the seat is in free fall, because
    // in the chassis's frame there is no gravity left. Both pass "does it sag".
    const falling = settleAt(GRAVITY.y) // the chassis accelerating at -32
    expect(Math.abs((falling.legs[0]?.angle ?? 1) * DEG)).toBeLessThan(0.01)
    expect((falling.legs[2]?.angle ?? 0) * DEG).toBeCloseTo(-1, 2) // its target
  })

  it('sags HALF AGAIN as far under full thrust', () => {
    // Climbing at the shipped net 18 m/s² the legs feel 50, not 32, so the
    // droop goes up by 50/32. The ratio is the assertion: it is independent of
    // the spring constant, so it tests the g_eff term and nothing else.
    const hovering = settleAt(0).legs[0]?.angle ?? 0
    const climbing = settleAt(18).legs[0]?.angle ?? 0
    expect(climbing / hovering).toBeCloseTo(50 / 32, 1)
    expect(climbing).toBeLessThan(hovering) // further down, not less far
  })

  it('neither freezes nor diverges — the two ways a units error shows', () => {
    // A spring 57x too stiff gives legs that never move; 57x too soft, or an
    // explicit damper at c·dt/I = 1.36, gives legs that ring away to infinity.
    // Both are what a units mistake looks like from the outside.
    const gear = settleAt(0, 2000)
    for (const leg of gear.legs) {
      expect(Math.abs(leg.angle * DEG)).toBeGreaterThan(0.2) // it moved
      expect(Math.abs(leg.angle)).toBeLessThan(Math.PI / 2) // it did not explode
      expect(Math.abs(leg.rate)).toBeLessThan(1e-6) // and it stopped
      expect(Number.isFinite(leg.angle)).toBe(true)
    }
  })

  it('settles in about a fifth of a second, without ringing', () => {
    // zeta = 1.72 under the shipped numbers — just past critical, which is
    // where hand-tuning a damper lands. An underdamped port overshoots its own
    // equilibrium and this catches it as an OVERSHOOT, not as a damping ratio.
    const gear = createJumpSeatLegs()
    const body = createRigidBody({ mass: JUMPSEAT.rigidbody.mass })
    let deepest = 0
    let settledAt = -1
    const target = settleAt(0).legs[0]?.angle ?? 0
    for (let i = 0; i < 200; i++) {
      stepJumpSeatLegs(gear, body, NO_GROUND, FIXED_DT)
      const a = gear.legs[0]?.angle ?? 0
      if (a < deepest) deepest = a
      if (settledAt < 0 && Math.abs(a - target) < 0.05 * Math.abs(target)) settledAt = i
    }
    expect(settledAt * FIXED_DT).toBeGreaterThan(0.05)
    expect(settledAt * FIXED_DT).toBeLessThan(0.35)
    expect(deepest).toBeGreaterThanOrEqual(target * 1.0001) // never went past it
  })
})

// ── the spring's units, both readings measured ────────────────────────────

describe('the spring’s units (OQ-6)', () => {
  it('ships the per-RADIAN reading, and the per-degree one is 57x stiffer', () => {
    expect(LEG_SPRING_UNITS_PER_RADIAN).toBe(1)

    const perRadian = settleAt(0).legs[0]?.angle ?? 0
    const perDegree = settleAt(0, 600, createJumpSeatLegSpecs(180 / Math.PI)).legs[0]?.angle ?? 0

    // The whole question, as two numbers. 0.88° of droop against 0.0155°.
    expect(perRadian * DEG).toBeCloseTo(-0.8786, 3)
    expect(perDegree * DEG).toBeCloseTo(-0.0155, 3)
    // 56.8, not 57.296: the two settle at different points on the same arc, so
    // the gravity torque they balance is not quite the same either. The size is
    // the assertion — it is the 57x this is about, not a rounding.
    expect(perRadian / perDegree).toBeGreaterThan(50)
    expect(perRadian / perDegree).toBeLessThan(60)

    // And what each is worth at the foot: 3.4 cm against 0.6 mm. A 0.6 mm droop
    // on a 2.5 m leg is not a thing anyone remembers ten years later, which is
    // the third of the four arguments in `sim/jumpseat-legs.ts`'s header.
    expect(footDrop(legNamed('back_l'), perRadian)).toBeGreaterThan(0.03)
    expect(footDrop(legNamed('back_l'), perDegree)).toBeLessThan(0.001)
  })

  it('would be caught by a stray degree/radian conversion anywhere', () => {
    // The `target` is in DEGREES on the prefab and radians in the spec. If it
    // were ever left in degrees, the front pair would rest 57° off the back
    // pair instead of 1°, which is a folded leg rather than a rake.
    expect(legNamed('front_l').target).toBeCloseTo(-0.0174533, 6)
    expect(footDrop(legNamed('front_l'), legNamed('front_l').target)).toBeLessThan(0.05)
  })
})

// ── 2. THEY CUSHION THE LANDING, measured A/B ─────────────────────────────

describe('they cushion the landing', () => {
  it('turns a set-down from a hard STOP into a settle: 197 m/s² -> 6.9', () => {
    // The headline, and the reason the legs are worth having. The comparison is
    // the SAME drop with `seat.legs = null`, so nothing else differs.
    const withLegs = drop(true, 1.6, 900)
    const without = drop(false, 1.6, 900)

    expect(without.peak).toBeGreaterThan(150) // 6 g, in one tick
    expect(withLegs.peak).toBeLessThan(20) // a fifth of a g
    expect(without.peak / withLegs.peak).toBeGreaterThan(10)

    // And it never reaches the hull at all — the gear catches it.
    expect(withLegs.lowest).toBeGreaterThan(0.8)
    expect(without.lowest).toBeCloseTo(0.61, 2)
  })

  it('is worth 3x on a real landing and tails off into a crash', () => {
    // A landing gear absorbs a landing and bottoms out on a crash. Both halves
    // are the behaviour; a "cushion" that held at 47 m/s would be a lie.
    const cases = [
      { height: 3, ticks: 900, minRatio: 2.5 },
      { height: 6, ticks: 900, minRatio: 1.2 },
    ]
    for (const c of cases) {
      const a = drop(true, c.height, c.ticks)
      const b = drop(false, c.height, c.ticks)
      expect(`${c.height}m:${b.peak / a.peak > c.minRatio}`).toBe(`${c.height}m:true`)
      expect(a.peak).toBeLessThan(b.peak)
    }
    // Terminal velocity: 0.6 m of travel at 47 m/s is 13 ms, and four 450 N·m
    // springs cannot absorb 14.5 kJ in 13 ms. They bottom out, and the hull
    // takes it — which is what happens to landing gear in a crash.
    const crash = drop(true, 300, 3000)
    const crashNoLegs = drop(false, 300, 3000)
    expect(crash.vImpact).toBeLessThan(-45)
    expect(crash.peak).toBeLessThan(crashNoLegs.peak)
    expect(crashNoLegs.peak / crash.peak).toBeLessThan(1.2)
  })

  it('parks the seat ON ITS GEAR, half a metre higher than on its belly', () => {
    const withLegs = drop(true, 3, 1200)
    const without = drop(false, 3, 1200)
    // DEV-530: 1.123 m on four level feet (1.140 while `front_l` stood 0.2 m
    // lower than the rest and parked squatting 10° to the others' 4-5°).
    expect(withLegs.settled).toBeCloseTo(1.123, 2)
    expect(without.settled).toBeCloseTo(0.61, 2)
    expect(withLegs.settled - without.settled).toBeGreaterThan(0.45)

    // The hover motor carries most of the weight at that height and the legs
    // take the rest: 100 N of the 480 N the seat weighs (103 before DEV-530).
    // If the legs were carrying all of it they would be doing the hover
    // motor's job.
    expect(withLegs.load).toBeCloseTo(100, 0)
    expect(withLegs.load).toBeLessThan(0.3 * JUMPSEAT.rigidbody.mass * Math.abs(GRAVITY.y))
  })

  it('HOLDS there — a suspension that hunts passes a single-sample check', () => {
    const seat = live(at(createJumpSeat(), 500, GROUND + 3, 500))
    const collision = createTerrainCollision()
    for (let i = 0; i < 1200; i++) {
      stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
      stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
    }
    const settled = seat.body.position.y
    let worst = 0
    for (let i = 0; i < 600; i++) {
      stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
      stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
      worst = Math.max(worst, Math.abs(seat.body.position.y - settled))
    }
    expect(worst).toBeLessThan(0.01)
  })

  it('compresses VISIBLY when it takes the weight — about 6°', () => {
    // The other half of "the legs move on screen": parked, the gear is squatting
    // several degrees, not sitting at its airborne droop of one.
    const seat = live(at(createJumpSeat(), 500, GROUND + 3, 500))
    const collision = createTerrainCollision()
    for (let i = 0; i < 1200; i++) {
      stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
      stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
    }
    for (const [i, leg] of (seat.legs?.legs ?? []).entries()) {
      expect(leg.grounded).toBe(true)
      expect(leg.angle * DEG).toBeGreaterThan(3)
      expect(leg.angle * DEG).toBeLessThan(30)
      // Compressed is the opposite sign from sagging — the foot is being
      // pushed UP relative to where it hangs in the air.
      expect(footDrop(SPECS[i] as JumpSeatLegSpec, leg.angle)).toBeLessThan(-0.1)
    }
  })

  it('parks on four legs squatting ALIKE, and level (DEV-530)', () => {
    // Before DEV-530 this seat parked with `front_l` at 10.1° and the others at
    // 4.4-5.3°, carrying 42 N to their 18-25, because that one strut was aimed
    // at a disabled foot box 0.2 m lower than the rest. On 2016's own frames
    // all four squat 5.91°; the front pair carries a little more (26.7 N to
    // 23.3) only because its spring aims a degree lower (the authored -1°
    // target), so the same angle is a degree more compression.
    const seat = live(at(createJumpSeat(), 500, GROUND + 3, 500))
    const collision = createTerrainCollision()
    for (let i = 0; i < 1200; i++) {
      stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
      stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
    }
    const legs = seat.legs?.legs ?? []
    const angles = legs.map((l) => l.angle * DEG)
    expect(Math.max(...angles) - Math.min(...angles)).toBeLessThan(0.01)
    expect(angles[0] as number).toBeCloseTo(5.91, 1)
    // Mirror pairs carry the same load; and the feet stand at one height.
    expect(legs[0]?.load).toBeCloseTo(legs[1]?.load ?? 0, 6)
    expect(legs[2]?.load).toBeCloseTo(legs[3]?.load ?? 0, 6)
    const feetY = legs.map((l, i) =>
      seat.legs
        ? legFootWorld(v3(), seat.legs.specs[i] as JumpSeatLegSpec, l.angle, seat.body).y
        : 0,
    )
    expect(Math.max(...feetY) - Math.min(...feetY)).toBeLessThan(1e-3)
  })

  it('carries nothing when the seat is UPSIDE DOWN', () => {
    // Inverted, the legs point at the sky and their swing has no upward
    // component left, so the inverse-dynamics division degenerates. The guard
    // is `MIN_VERTICAL_SWING`, and what it has to produce is zero load rather
    // than a division by something near zero.
    const seat = live(at(createJumpSeat(), 500, GROUND + 0.5, 500))
    seat.body.orientation = { x: 1, y: 0, z: 0, w: 0 } // 180° about x
    for (let i = 0; i < 200; i++) {
      stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
      expect(Number.isFinite(seat.body.force.y)).toBe(true)
      expect(Number.isFinite(seat.body.position.y)).toBe(true)
      expect(seat.legs?.totalLoad).toBe(0)
    }
  })

  it('never pulls the seat DOWN, at any attitude', () => {
    // A leg is standing on the ground, not bolted to it. An inverse-dynamics
    // model that forgot the clamp would suck the seat into a hillside the
    // moment the geometry put the spring the other way up.
    const seat = live(at(createJumpSeat(), 500, GROUND + 1.2, 500))
    for (let i = 0; i < 400; i++) {
      stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
      expect(seat.legs?.totalLoad ?? 0).toBeGreaterThanOrEqual(0)
      for (const leg of seat.legs?.legs ?? []) expect(leg.load).toBeGreaterThanOrEqual(0)
    }
  })
})

// ── TRAP 19 ───────────────────────────────────────────────────────────────

describe('trap 19 — step a SECOND one', () => {
  const snapshot = (gear: ReturnType<typeof createJumpSeatLegs>) => gear.legs.map((l) => ({ ...l }))

  it('leaves an idle gear alone while another one lands', () => {
    // Four scratch vectors and a per-gear `lastVelocity`: exactly the shape
    // `ai-racer.ts` was in when a finished racer inherited another racer's
    // stick. `idle` is STEPPED — the bug is never "not stepped".
    const idle = createJumpSeatLegs()
    const idleBody = createRigidBody({ mass: JUMPSEAT.rigidbody.mass })
    const landing = createJumpSeatLegs()
    const landingBody = createRigidBody({ mass: JUMPSEAT.rigidbody.mass })
    landingBody.position.x = 500
    landingBody.position.z = 500
    landingBody.position.y = GROUND + 2
    landingBody.velocity.y = -12

    for (let i = 0; i < 400; i++) {
      stepJumpSeatLegs(landing, landingBody, [FLAT], FIXED_DT)
      landingBody.velocity.y += (GRAVITY.y + landingBody.force.y / landingBody.mass) * FIXED_DT
      landingBody.position.y += landingBody.velocity.y * FIXED_DT
      landingBody.force.y = 0
      stepJumpSeatLegs(idle, idleBody, NO_GROUND, FIXED_DT)
    }
    // The idle one only ever felt gravity, so it is at its static sag and
    // nothing else — not the other gear's impact, not the other gear's load.
    for (const [i, leg] of idle.legs.entries()) {
      expect(leg.grounded).toBe(false)
      expect(leg.load).toBe(0)
      expect(leg.angle).toBeCloseTo(legStaticSag(SPECS[i] as JumpSeatLegSpec), 3)
    }
    expect(idle.totalLoad).toBe(0)
    expect(landing.totalLoad).toBeGreaterThan(0)
  })

  it('gives interleaved seats the SAME trajectories as lone twins, bit for bit', () => {
    // The general form. Any module-level state shared between two gears shows
    // up as a difference in one of the four runs.
    const runPair = (interleaved: boolean) => {
      const a = live(at(createJumpSeat(), 500, GROUND + 9, 500))
      const b = live(at(createJumpSeat(), 520, GROUND + 2, 520))
      b.body.velocity.y = -18
      const stepA = () => stepJumpSeat(a, { ...noJumpSeatInput(), throttle: 1 }, [FLAT], FIXED_DT)
      const stepB = () => stepJumpSeat(b, noJumpSeatInput(), [FLAT], FIXED_DT)
      if (interleaved) {
        for (let i = 0; i < 600; i++) {
          stepA()
          stepB()
        }
      } else {
        for (let i = 0; i < 600; i++) stepA()
      }
      return {
        a: { p: { ...a.body.position }, legs: snapshot(a.legs as NonNullable<typeof a.legs>) },
        b: { p: { ...b.body.position }, legs: snapshot(b.legs as NonNullable<typeof b.legs>) },
      }
    }
    const together = runPair(true)
    const aAlone = runPair(false)
    expect(together.a).toEqual(aAlone.a)

    // And B on its own, the other way round.
    const bLone = live(at(createJumpSeat(), 520, GROUND + 2, 520))
    bLone.body.velocity.y = -18
    for (let i = 0; i < 600; i++) stepJumpSeat(bLone, noJumpSeatInput(), [FLAT], FIXED_DT)
    expect(snapshot(bLone.legs as NonNullable<typeof bLone.legs>)).toEqual(together.b.legs)
  })

  it('does not let one seat’s acceleration reach another seat’s legs', () => {
    // `lastVelocity` is the field this is about. A module-level one would hand
    // the stationary seat the flying seat's Δv and sag its legs for free.
    const flying = createJumpSeatLegs()
    const flyingBody = createRigidBody({ mass: JUMPSEAT.rigidbody.mass })
    const parked = createJumpSeatLegs()
    const parkedBody = createRigidBody({ mass: JUMPSEAT.rigidbody.mass })

    for (let i = 0; i < 501; i++) {
      // A chassis being flung about: +60 / -30 m/s² on alternate ticks, over an
      // ODD number of them, so it ends up somewhere rather than back at rest.
      flyingBody.velocity.y += (i % 2 === 0 ? 60 : -30) * FIXED_DT
      stepJumpSeatLegs(flying, flyingBody, NO_GROUND, FIXED_DT)
      stepJumpSeatLegs(parked, parkedBody, NO_GROUND, FIXED_DT)
    }
    // The parked gear never moved, so its legs are at the static sag exactly.
    for (const [i, leg] of parked.legs.entries()) {
      expect(leg.angle).toBeCloseTo(legStaticSag(SPECS[i] as JumpSeatLegSpec), 3)
    }
    expect(parked.lastVelocity.y).toBe(0)
    expect(flying.lastVelocity.y).not.toBe(0)
  })

  it('keeps two resets independent', () => {
    const a = settleAt(0)
    const b = settleAt(0)
    resetJumpSeatLegs(a)
    expect(a.legs[0]?.angle).toBe(0)
    expect(a.primed).toBe(false)
    expect(b.legs[0]?.angle).toBeLessThan(0)
    expect(b.primed).toBe(true)
  })
})

// ── the fixed step ────────────────────────────────────────────────────────

describe('the integrator seam', () => {
  it('never sees a frame delta', () => {
    const a = live(at(createJumpSeat(), 500, GROUND + 4, 500))
    const b = live(at(createJumpSeat(), 500, GROUND + 4, 500))
    for (let i = 0; i < 400; i++) {
      stepJumpSeat(a, noJumpSeatInput(), [FLAT])
      stepJumpSeat(b, noJumpSeatInput(), [FLAT], FIXED_DT)
    }
    expect(a.body.position).toEqual(b.body.position)
    expect(a.legs?.legs).toEqual(b.legs?.legs)
  })

  it('does not disturb a seat with no ground under it', () => {
    // Airborne, the legs contribute no force at all — they are hanging, not
    // pushing. A model that leaked a reaction while free would change the
    // terminal speeds, which `jumpseat.test.ts` pins to four decimal places.
    const seat = live(createJumpSeat())
    for (let i = 0; i < 4000; i++) {
      stepJumpSeat(seat, noJumpSeatInput(), NO_GROUND, FIXED_DT)
      expect(seat.legs?.totalLoad).toBe(0)
    }
    expect(-seat.body.velocity.y).toBeCloseTo(48.8404, 3)
  })
})

// ── the render seam reads the sim ─────────────────────────────────────────

describe('legFootLocal is the one place a foot position comes from', () => {
  it('moves a real distance for a real angle', () => {
    // The render draws each leg between `spec.pivot` and this point. If the
    // angle did not move it, the legs would be four static cylinders again —
    // which is what they were before this session and what nobody noticed.
    const spec = legNamed('back_l')
    const rest = legFootLocal(v3(), spec, 0)
    const sagged = legFootLocal(v3(), spec, -0.0156)
    const squat = legFootLocal(v3(), spec, 0.25)
    expect(Math.hypot(sagged.x - rest.x, sagged.y - rest.y, sagged.z - rest.z)).toBeCloseTo(
      0.0393,
      3,
    )
    expect(Math.hypot(squat.x - rest.x, squat.y - rest.y, squat.z - rest.z)).toBeGreaterThan(0.6)
    // The foot stays exactly `contactDistance` from the hinge at every angle —
    // it is a rigid strut on a hinge, not a telescope.
    for (const angle of [-0.3, -0.05, 0, 0.05, 0.4, 1.2]) {
      const f = legFootLocal(v3(), spec, angle)
      expect(Math.hypot(f.x - spec.pivot.x, f.y - spec.pivot.y, f.z - spec.pivot.z)).toBeCloseTo(
        spec.contactDistance,
        9,
      )
    }
  })

  it('leaves the caller’s vector alone but for the write', () => {
    const out: Vec3 = v3(9, 9, 9)
    const returned = legFootLocal(out, legNamed('front_r'), 0)
    expect(returned).toBe(out)
  })

  it('carries into world space through the body, at an odd attitude', () => {
    // `legFootWorld` is the same point with the chassis pose composed on. The
    // check is the one thing a composition cannot fake: the foot stays exactly
    // `contactDistance` from the hinge, wherever the ship is pointing, and it
    // moves with the hull rather than staying put in the world.
    const seat = createJumpSeat()
    const spec = legNamed('front_l')
    const angle = 0.2
    const half = 1.1 / 2
    const axis = v3(0.5488, 0.2194, 0.8066)
    const len = Math.hypot(axis.x, axis.y, axis.z)
    const s = Math.sin(half) / len
    seat.body.orientation = { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) }
    seat.body.position.x = 123
    seat.body.position.y = -45
    seat.body.position.z = 678

    const foot = legFootWorld(v3(), spec, angle, seat.body)
    const hinge = rotateVec3(v3(), seat.body.orientation, spec.pivot)
    hinge.x += seat.body.position.x
    hinge.y += seat.body.position.y
    hinge.z += seat.body.position.z
    expect(Math.hypot(foot.x - hinge.x, foot.y - hinge.y, foot.z - hinge.z)).toBeCloseTo(
      spec.contactDistance,
      9,
    )
    // And it is nowhere near the origin — the body pose really is applied.
    expect(Math.hypot(foot.x, foot.y, foot.z)).toBeGreaterThan(600)
  })
})

// ── the hinge, against the prefab's own rotation ──────────────────────────

describe('the hinge axis', () => {
  it('IS the axis the prefab serialises, composed here by hand', () => {
    // `sim/jumpseat-legs.ts` takes each hinge from the capsule's composed frame
    // on the sheet (DEV-530; before it, the hinge was RECONSTRUCTED from two
    // measured points and sat 2.70° / 4.24° / 3.59° / 3.18° off). This composes
    // the frame a second way, independently of the extractor's chain walk: the
    // prefab's own `localTransform.rotation` with its group's, rotating the
    // sheet's local `axis` (1,0,0) by it, and measures the ANGLE between that
    // and the spec's.
    //
    // The group rotation is DERIVED here rather than typed: `legs_back` is
    // `legs_front` yawed 180°, which shows up as the leg's local z having the
    // opposite sign from its composed z. Both back legs say so independently,
    // and so do both front legs the other way.
    const YAW180 = { x: 0, y: 1, z: 0, w: 0 }
    const IDENTITY = { x: 0, y: 0, z: 0, w: 1 }
    for (const spec of SPECS) {
      const leg = JUMPSEAT.legs.find((l) => l.name === spec.name)
      const capsule = JUMPSEAT.colliders.find(
        (c) => c.name === spec.name && c.parentPath === leg?.parentPath && c.enabled,
      )
      if (!leg || !capsule) throw new Error(`no capsule for ${spec.name}`)
      const local = capsule.localTransform.position
      const group = Math.sign(local.z) === Math.sign(leg.composedPosition.z) ? IDENTITY : YAW180
      const composed = mul({ x: 0, y: 0, z: 0, w: 1 }, group, capsule.localTransform.rotation)
      const prefabAxis = rotateVec3(v3(), composed, v3(leg.axis.x, leg.axis.y, leg.axis.z))

      // The SIGN of a hinge axis is a convention — +θ about `a` is −θ about
      // `-a` — so what is asserted is the LINE, which is geometry. The sheet
      // rounds its quaternions to 1e-6, which leaves them a part in a million
      // off unit length, so the angle is taken between NORMALISED directions.
      const offBy = angleBetween(prefabAxis, spec.axis, true)
      expect(`${spec.name}:${offBy < 0.01}`).toBe(`${spec.name}:true`)
      // And the strut is the capsule's own local -Y, the same way.
      const prefabStrut = rotateVec3(v3(), composed, v3(0, -1, 0))
      const strutOff = angleBetween(prefabStrut, spec.strut, false)
      expect(`${spec.name}:${strutOff < 0.01}`).toBe(`${spec.name}:true`)
    }
  })
})

// ── the body a seat with no gear is ───────────────────────────────────────

describe('a seat with no gear', () => {
  it('is what `legs = null` gives, and it still flies', () => {
    const seat = live(createJumpSeat())
    expect(seat.legs).not.toBeNull()
    seat.legs = null
    for (let i = 0; i < 4000; i++) stepJumpSeat(seat, noJumpSeatInput(), NO_GROUND, FIXED_DT)
    expect(-seat.body.velocity.y).toBeCloseTo(48.8404, 3)
  })
})
