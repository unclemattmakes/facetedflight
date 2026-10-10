// tests/unit/jumpseat-jump.test.ts — the jumping spider's jump. DEV-383.
//
// Matt, 2026-09-24: *"pull both triggers to charge a 'jump burst' that when
// released, launches players into the air. then a slightly weaker hover jet so
// you control your descent rather than gain altitude."* The mechanic is
// `src/sim/jumpseat-jump.ts`, called from two places in `stepJumpSeat`; the
// spider is `content/aircraft/jumpseat.json`'s first variant.
//
// ── Relationships, not values (trap 24) ─────────────────────────────────────
//
// The spider is flown through the seam's own `jumpSeatFor` off the CONTENT, and
// every flight number is compared against something that is not the mechanic
// written twice: the standard seat flown the same way, the content's own
// factors, or a closed form of the physics.
//
// Proved red, each against the product (a scratch runner applied one
// mutation, ran this file, and put the source back):
//  - the charge: `stepJumpSeat` handing the charge throttle OR boost (4 red,
//    the one-trigger cases first), and `stepJumpCharge` dropping the footing
//    half (2 red, the free-air cases);
//  - the launch: the burst edited along WORLD up instead of the body's (2 red),
//    and `burstTicks` returning 1 (the burst test);
//  - no jump in the air: `jumpSupported` returning true (3 red);
//  - the weaker jet: the spider's `thruster.thrustForce` at x0.7 (2 red: it
//    climbs);
//  - standard and overclocked unchanged: `stepJumpSeat` handing every seat a
//    boost of 1 (both recordings red);
//  - the pad underside: `belowField` never true (the 120 m push under a pad
//    comes back) and true for every point of a pad (a seat standing on one
//    sinks through it);
//  - a dry spider: the latch dropped from the charge's `lit` (it charges);
//  - trap 19: `createJump` handing every seat one shared `JumpState` (6 red,
//    the second-spider test among them).

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type Aircraft,
  AircraftSchemaError,
  JUMP_NUMBER_FIELDS,
  STANDARD_VARIANT_ID,
  VARIANT_MECHANICS,
  validateAircraft,
  validateJump,
} from '@/content/aircraft-schema'
import { resolveVariant } from '@/content/load-aircraft'
import { jumpSeatFor } from '@/game/jumpseat-flight'
import { JUMPSEAT } from '@/generated/constants.generated'
import { FIXED_DT } from '@/sim/constants'
import { createJumpSeat, type JumpSeat, noJumpSeatInput, stepJumpSeat } from '@/sim/jumpseat'
import {
  applyJumpBurst,
  burstTicks,
  type JumpSpec,
  jumpDv,
  jumpFooting,
  stepJumpCharge,
} from '@/sim/jumpseat-jump'
import { createRefuel } from '@/sim/jumpseat-refuel'
import { createStranded, type StrandedSpec, stepJumpSeatStranded } from '@/sim/jumpseat-stranded'
import { rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { buildPadField } from '@/sim/pad-surface'
import type { FacetedTerrainParams } from '@/sim/terrain/faceted'
import { buildHeightField, type HeightField } from '@/sim/terrain/height-field'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import {
  collisionAngularDrag,
  createTerrainCollision,
  hullFromColliders,
  stepTerrainCollision,
  type TerrainCollisionSpec,
} from '@/sim/terrain-collision'
import { SPIDER_READY } from './helpers/spider-ready'
import { type Fingerprint, flyJumpSeatScript } from './helpers/variant-flight'

const ANNIVERSARY = { gameplay: { variants: { enabled: true } } }
const SPIDER = 'spider'

const spiderVariant = () => {
  const v = resolveVariant('jumpseat', SPIDER, ANNIVERSARY)
  expect(v.id, 'the content resolves the spider rather than falling back').toBe(SPIDER)
  return v
}
const spider = (): JumpSeat => jumpSeatFor(spiderVariant())
const spec = (): JumpSpec => {
  const s = spider().jump
  if (!s) throw new Error('the spider has no jump')
  return s.spec
}

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

/** Flat ground at y = 50 over a 1 km square: `jumpseat.test.ts`'s own. */
const FLAT: HeightField = buildHeightField(
  flatMap(0.5),
  {
    terrainSize: 1024,
    terrainHeight: 100,
    baseResolution: 8,
    chunkSize: 256,
    randomOffset: 0,
    seed: 1,
  } as unknown as FacetedTerrainParams,
  { position: [0, 0, 0], scale: [1, 1, 1] },
)
const GROUND = 50

/** The seam's ground rule, as `jumpseat-legs.test.ts` copies it. */
const COLLISION: TerrainCollisionSpec = {
  hull: hullFromColliders(
    JUMPSEAT.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
  ),
  restitution: 0,
  friction: 0.6,
  flashSeconds: 0.3,
  flashAngularDrag: 3,
}

/** One seat on flat ground, stepped in the seam's order: the step, then the hull. */
const onGround = (seat: JumpSeat) => {
  seat.live = true
  seat.body.position.x = 500
  seat.body.position.y = GROUND + 3
  seat.body.position.z = 500
  const collision = createTerrainCollision()
  const tick = (throttle: number, boost: number, pitch = 0): void => {
    const input = { ...noJumpSeatInput(), throttle, boost, pitch }
    stepJumpSeat(seat, input, [FLAT], FIXED_DT)
    stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
    seat.body.angularDrag = collisionAngularDrag(collision, COLLISION, seat.tuning.angularDrag)
  }
  // Settle on the gear, throttle shut.
  for (let i = 0; i < 600; i++) tick(0, 0)
  return tick
}

const ticks = (seconds: number): number => Math.round(seconds / FIXED_DT)

// ── 1. the content and its validator ──────────────────────────────────────

const withJump = (jump: unknown) =>
  ({
    vehicle: 'jumpseat',
    variants: [
      { id: STANDARD_VARIANT_ID, name: 'Standard', blurb: '2016', scale: {} },
      { id: 'probe', name: 'Probe', blurb: 'x', scale: {}, mechanics: { jump } },
    ],
  }) as unknown as Aircraft

// NOT READY TO SHIP (Matt, 2026-09-25, DEV-403): the spider is `listed: false`,
// and its tests skip on `SPIDER_READY` until it is ready (`variant-listed.test.ts`).
describe.skipIf(!SPIDER_READY)(
  'the spider is content, and the jump is a mechanic the validator knows',
  () => {
    it('is the first JumpSeat variant, ABOVE standard (§6.2: nimble left, standard in the middle)', () => {
      const ids = (
        JSON.parse(fs.readFileSync('content/aircraft/jumpseat.json', 'utf8')) as Aircraft
      ).variants.map((v) => v.id)
      expect(ids.indexOf(SPIDER)).toBeGreaterThanOrEqual(0)
      expect(ids.indexOf(SPIDER)).toBeLessThan(ids.indexOf(STANDARD_VARIANT_ID))
    })

    it('scales only the jet and its burn, and carries a jump', () => {
      const v = spiderVariant()
      expect(Object.keys(v.scale).sort()).toEqual(['fuel.burnRate', 'thruster.thrustForce'])
      expect(Object.keys(v.mechanics)).toEqual(['jump'])
      expect(VARIANT_MECHANICS.jumpseat).toContain('jump')
      expect(VARIANT_MECHANICS.hoverjet).not.toContain('jump')
    })

    it("the schema's jump fields are exactly the validator's", () => {
      const schema = JSON.parse(fs.readFileSync('content/aircraft/_schema.json', 'utf8')) as {
        $defs: Record<string, { properties?: Record<string, unknown>; required?: string[] }>
      }
      const node = schema.$defs.jumpseatJump
      expect(Object.keys(node?.properties ?? {}).sort()).toEqual(
        [...JUMP_NUMBER_FIELDS, 'curve'].sort(),
      )
      expect([...(node?.required ?? [])].sort()).toEqual([...JUMP_NUMBER_FIELDS, 'curve'].sort())
    })

    it('refuses a jump that cannot be flown', () => {
      const good = JSON.parse(JSON.stringify(spec())) as Record<string, unknown>
      expect(() => validateAircraft(withJump(good))).not.toThrow()
      const bad = (patch: Record<string, unknown>, why: RegExp): void => {
        const j = { ...good, ...patch }
        expect(() => validateAircraft(withJump(j), 'probe.json'), JSON.stringify(patch)).toThrow(
          why,
        )
      }
      bad({ chargeSeconds: 0 }, /chargeSeconds must be above zero/)
      bad({ burstSeconds: -1 }, /burstSeconds must be above zero/)
      bad({ minChargeSeconds: 5 }, /minChargeSeconds must lie between/)
      bad({ impulseMin: -1 }, /impulseMin must not be negative/)
      bad({ impulseMax: 1, impulseMin: 2 }, /impulseMax must be above zero and at least impulseMin/)
      bad({ graceSeconds: -0.1 }, /graceSeconds must not be negative/)
      bad({ impulseMax: Number.NaN }, /impulseMax must be a finite number/)
      bad({ double: true }, /has no field "double"/)
      bad({ curve: { keys: [] } }, /curve has no keys/)
      bad(
        {
          curve: {
            keys: [
              { time: 0.5, value: 0, inSlope: 0, outSlope: 0 },
              { time: 0.5, value: 1, inSlope: 0, outSlope: 0 },
            ],
          },
        },
        /must rise strictly/,
      )
      bad({ curve: { keys: [{ time: 0, value: 2, inSlope: 0, outSlope: 0 }] } }, /value must lie/)
      const { graceSeconds: _omit, ...missing } = good
      expect(() => validateAircraft(withJump(missing))).toThrow(AircraftSchemaError)
    })

    it('refuses a jump on the HoverJet and on standard', () => {
      const jet = {
        vehicle: 'hoverjet',
        variants: [
          { id: STANDARD_VARIANT_ID, name: 'S', blurb: 'x', scale: {} },
          { id: 'probe', name: 'P', blurb: 'x', scale: {}, mechanics: { jump: spec() } },
        ],
      } as unknown as Aircraft
      expect(() => validateAircraft(jet)).toThrow(
        /mechanics "jump" is not implemented for the hoverjet/,
      )
      const std = {
        vehicle: 'jumpseat',
        variants: [
          {
            id: STANDARD_VARIANT_ID,
            name: 'S',
            blurb: 'x',
            scale: {},
            mechanics: { jump: spec() },
          },
        ],
      } as unknown as Aircraft
      expect(() => validateAircraft(std)).toThrow(/carries no mechanics/)
    })

    it('the seam validates a hand-built jump rather than casting it', () => {
      const v = spiderVariant()
      expect(() =>
        jumpSeatFor({ id: 'probe', scale: v.scale, mechanics: { jump: { impulseMax: 'high' } } }),
      ).toThrow(AircraftSchemaError)
      expect(validateJump(spec(), 'x')).toEqual(spec())
    })
  },
)

// ── 2. the charge ─────────────────────────────────────────────────────────

describe.skipIf(!SPIDER_READY)('the charge: both triggers, on a surface', () => {
  it('accrues only with BOTH held — throttle alone or boost alone charges nothing', () => {
    for (const [throttle, boost, charges] of [
      [0, 0, false],
      [1, 0, false],
      [0, 1, false],
      [1, 1, true],
    ] as const) {
      const seat = spider()
      const tick = onGround(seat)
      for (let i = 0; i < ticks(0.5); i++) tick(throttle, boost)
      const jump = seat.jump
      const expected = charges ? (ticks(0.5) * FIXED_DT) / spec().chargeSeconds : 0
      expect(jump?.charge ?? 0, `throttle ${throttle} boost ${boost}`).toBeCloseTo(expected, 12)
    }
  })

  it('fills over chargeSeconds and stops full; the tank pays the boosted rate while it fills and nothing after', () => {
    const seat = spider()
    const tick = onGround(seat)
    const s = spec()
    const f0 = seat.fuel
    for (let i = 0; i < ticks(s.chargeSeconds); i++) tick(1, 1)
    expect(seat.jump?.charge).toBeCloseTo(1, 12)
    const filled = f0 - seat.fuel
    const expected = seat.tuning.burnRate * seat.tuning.boostBurnRateMultiplier * s.chargeSeconds
    expect(filled / expected).toBeCloseTo(1, 2)
    // Held full: no more burn, no thrust (the seat crouches on its gear).
    const f1 = seat.fuel
    for (let i = 0; i < ticks(1); i++) {
      tick(1, 1)
      expect(seat.appliedThrust).toBe(0)
    }
    expect(seat.fuel).toBe(f1)
    expect(seat.jump?.charge).toBe(1)
  })

  it('a release under minChargeSeconds does nothing; one past it fires', () => {
    const s = spec()
    for (const [held, fires] of [
      [s.minChargeSeconds * 0.5, false],
      [s.minChargeSeconds * 2, true],
    ] as const) {
      const seat = spider()
      const tick = onGround(seat)
      for (let i = 0; i < ticks(held); i++) tick(1, 1)
      tick(1, 0)
      expect(seat.jump?.jumps, `held ${held} s`).toBe(fires ? 1 : 0)
    }
  })

  it('a dry spider cannot charge: the jump is the thruster, and the thruster is latched off', () => {
    const seat = spider()
    const tick = onGround(seat)
    seat.fuel = 0
    tick(0, 0)
    expect(seat.thrusterEnabled).toBe(false)
    for (let i = 0; i < ticks(1.5); i++) tick(1, 1)
    tick(1, 0)
    expect(seat.jump?.charge).toBe(0)
    expect(seat.jump?.jumps).toBe(0)
  })
})

// ── 3. the launch ─────────────────────────────────────────────────────────

describe.skipIf(!SPIDER_READY)('the launch: along the seat, over the burst, by the curve', () => {
  it('dv runs impulseMin to impulseMax along the content curve', () => {
    const s = spec()
    expect(jumpDv(s, 0)).toBe(s.impulseMin)
    expect(jumpDv(s, 1)).toBe(s.impulseMax)
    const mid = jumpDv(s, 0.5)
    expect(mid).toBeGreaterThan(s.impulseMin)
    expect(mid).toBeLessThan(s.impulseMax)
    // A curve is data: an ease-in (value 0 with zero slopes at both ends of a
    // cubic) buys less than the linear half at the middle.
    const easeIn: JumpSpec = {
      ...s,
      curve: {
        keys: [
          { time: 0, value: 0, inSlope: 0, outSlope: 0 },
          { time: 1, value: 1, inSlope: 2, outSlope: 2 },
        ],
      },
    }
    expect(jumpDv(easeIn, 0.5)).toBeLessThan(mid)
  })

  it("the burst edits the velocity by exactly dv along the SEAT's up, over the burst's ticks", () => {
    const s = spec()
    const n = burstTicks(s, FIXED_DT)
    expect(n).toBe(Math.round(s.burstSeconds / FIXED_DT))
    expect(n).toBeGreaterThan(1)
    const seat = spider()
    const jump = seat.jump as NonNullable<JumpSeat['jump']>
    // Charged full on a stand-in "surface", released, then the burst alone —
    // `applyJumpBurst` on a body leaned 30 degrees, nothing else acting.
    const tickOut = { charging: false, burning: false, fired: false }
    for (let i = 0; i < ticks(s.chargeSeconds); i++)
      stepJumpCharge(jump, true, true, true, FIXED_DT, tickOut)
    stepJumpCharge(jump, false, true, true, FIXED_DT, tickOut)
    expect(tickOut.fired).toBe(true)
    const q = { x: Math.sin(0.2618), y: 0, z: 0, w: Math.cos(0.2618) }
    seat.body.orientation.x = q.x
    seat.body.orientation.w = q.w
    const up = v3()
    rotateVec3(up, q, v3(0, 1, 0))
    let ticksBursting = 0
    while (applyJumpBurst(jump, seat.body)) ticksBursting++
    expect(ticksBursting).toBe(n)
    const v = seat.body.velocity
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(s.impulseMax, 9)
    expect((v.x * up.x + v.y * up.y + v.z * up.z) / s.impulseMax).toBeCloseTo(1, 12)
    expect(up.z).not.toBeCloseTo(0, 3)
  })

  it('in the step, a leaned launch goes where the seat leans', () => {
    const seat = spider()
    const tick = onGround(seat)
    const s = spec()
    // Lean on the gear with the stick while charging, then let go of boost.
    for (let i = 0; i < ticks(s.chargeSeconds); i++) tick(1, 1, 1)
    const up = v3()
    rotateVec3(up, seat.body.orientation, v3(0, 1, 0))
    expect(Math.acos(up.y)).toBeGreaterThan(0.05)
    for (let i = 0; i < burstTicks(s, FIXED_DT); i++) tick(1, 0)
    const v = seat.body.velocity
    const flat = Math.hypot(v.x, v.z)
    const lean = Math.hypot(up.x, up.z)
    // Horizontal velocity along the lean's own heading, and in proportion.
    expect((v.x * up.x + v.z * up.z) / (flat * lean)).toBeGreaterThan(0.9)
    expect(flat / v.y).toBeGreaterThan((0.5 * lean) / up.y)
  })

  it('a full release from the ground reaches the apex of the same dv set in free air, within 5 %', () => {
    // Jet held after the release (let go of the boost side only, §4.1). The
    // reference is the plan's own measurement (§4.2, §A): the SAME step
    // function, the whole dv set at once on a seat with no ground and no gear.
    // What differs is the burst's 0.12 s, the gear and cushion under it and the
    // thrust ramp restarting — none of which may cost the jump more than 5 %.
    const seat = spider()
    const tick = onGround(seat)
    const s = spec()
    const y0 = seat.body.position.y
    for (let i = 0; i < ticks(s.chargeSeconds); i++) tick(1, 1)
    let top = y0
    for (let i = 0; i < ticks(15); i++) {
      tick(1, 0)
      if (seat.body.position.y > top) top = seat.body.position.y
    }
    const free = spider()
    free.live = true
    free.legs = null
    free.body.position.y = 10_000
    free.body.velocity.y = s.impulseMax
    let freeTop = free.body.position.y
    for (let i = 0; i < ticks(15); i++) {
      stepJumpSeat(free, { ...noJumpSeatInput(), throttle: 1 }, [], FIXED_DT)
      if (free.body.position.y > freeTop) freeTop = free.body.position.y
    }
    const measured = freeTop - 10_000
    expect(Math.abs(top - y0 - measured) / measured).toBeLessThan(0.05)
    // And the full jump clears 150 m, which is what the shipped numbers are
    // FOR: DEVIATIONS DEV-383 has the pads the tabled 75 m/s could not reach.
    expect(top - y0).toBeGreaterThan(150)
  })
})

// ── 4. no jump in the air ─────────────────────────────────────────────────

describe.skipIf(!SPIDER_READY)('no jump in the air (§11 answer 5: from a surface only)', () => {
  it('in free air both triggers charge nothing, fire nothing, and only lift', () => {
    const seat = spider()
    seat.live = true
    seat.legs = null
    seat.body.position.y = 10_000
    for (let i = 0; i < ticks(3); i++) {
      stepJumpSeat(seat, { ...noJumpSeatInput(), throttle: 1, boost: 1 }, [], FIXED_DT)
      expect(seat.jump?.charge).toBe(0)
    }
    stepJumpSeat(seat, { ...noJumpSeatInput(), throttle: 1, boost: 0 }, [], FIXED_DT)
    expect(seat.jump?.jumps).toBe(0)
    expect(seat.appliedThrust).toBeGreaterThan(0)
    expect(jumpFooting(seat.jump as NonNullable<JumpSeat['jump']>)).toBe(false)
  })

  it('a charge begun on the ground and carried off it is dropped, not fired', () => {
    const seat = spider()
    const tick = onGround(seat)
    const s = spec()
    for (let i = 0; i < ticks(s.chargeSeconds * 0.8); i++) tick(1, 1)
    // Lifted clear of everything, both still held, past the grace.
    seat.body.position.y += 200
    seat.legs = null
    for (let i = 0; i < ticks(s.graceSeconds * 2); i++) tick(1, 1)
    tick(1, 0)
    expect(seat.jump?.jumps).toBe(0)
    expect(seat.jump?.charge).toBe(0)
  })
})

// ── 5. the weaker jet ─────────────────────────────────────────────────────

describe.skipIf(!SPIDER_READY)(
  'the weaker jet: the spider controls its descent and cannot climb',
  () => {
    const terminal = (seat: JumpSeat): number => {
      seat.live = true
      seat.legs = null
      seat.burnsFuel = false
      seat.body.position.y = 100_000
      for (let i = 0; i < ticks(20); i++) {
        stepJumpSeat(seat, { ...noJumpSeatInput(), throttle: 1 }, [], FIXED_DT)
      }
      return seat.body.velocity.y
    }

    it("its jet is the content's fraction of 2016's, and less than the seat weighs", () => {
      const s = spider()
      const standard = createJumpSeat()
      const factor = spiderVariant().scale['thruster.thrustForce'] as number
      expect(s.tuning.thrustForce / standard.tuning.thrustForce).toBeCloseTo(factor, 12)
      expect(s.tuning.thrustForce).toBeLessThan(s.body.mass * Math.abs(s.gravity.y))
    })

    it("full throttle sinks — where 2016's seat climbs — and far slower than a free fall", () => {
      const sink = terminal(spider())
      expect(sink).toBeLessThan(0)
      expect(terminal(createJumpSeat())).toBeGreaterThan(0)
      const fall = spider()
      fall.live = true
      fall.legs = null
      fall.body.position.y = 100_000
      for (let i = 0; i < ticks(20); i++) stepJumpSeat(fall, noJumpSeatInput(), [], FIXED_DT)
      expect(Math.abs(sink)).toBeLessThan(Math.abs(fall.body.velocity.y) / 10)
    })

    it('in the air, both triggers are the jet and nothing more: no boost', () => {
      const lift = (boost: number): number => {
        const seat = spider()
        seat.live = true
        seat.legs = null
        seat.body.position.y = 10_000
        for (let i = 0; i < ticks(2); i++) {
          stepJumpSeat(seat, { ...noJumpSeatInput(), throttle: 1, boost }, [], FIXED_DT)
        }
        return seat.appliedThrust
      }
      expect(lift(1)).toBe(lift(0))
    })
  },
)

// ── 6. standard and overclocked are unchanged ─────────────────────────────

const STANDARD_RECORDING = JSON.parse(
  fs.readFileSync('tests/unit/fixtures/variant-standard-trajectory.json', 'utf8'),
) as { jumpseat: Fingerprint }
const OVERCLOCKED_RECORDING = JSON.parse(
  fs.readFileSync('tests/unit/fixtures/variant-overclocked-trajectory.json', 'utf8'),
) as {
  recordedAt: string
  variant: { id: string; scale: Record<string, number>; mechanics: Record<string, unknown> }
  jumpseat: Fingerprint
}

describe('a seat with no jump flies exactly as before DEV-383', () => {
  it('standard and overclocked carry no jump', () => {
    expect(createJumpSeat().jump).toBeNull()
    expect(jumpSeatFor(resolveVariant('jumpseat', 'overclocked', ANNIVERSARY)).jump).toBeNull()
  })

  it("standard reproduces DEV-380's recorded flight, bit for bit", () => {
    expect(flyJumpSeatScript(createJumpSeat()).sha256).toBe(STANDARD_RECORDING.jumpseat.sha256)
  })

  it(`overclocked reproduces its flight recorded at ${OVERCLOCKED_RECORDING.recordedAt}, bit for bit`, () => {
    const seat = jumpSeatFor(OVERCLOCKED_RECORDING.variant)
    expect(flyJumpSeatScript(seat).sha256).toBe(OVERCLOCKED_RECORDING.jumpseat.sha256)
  })
})

// ── 7. per seat, and the same run twice ───────────────────────────────────

describe.skipIf(!SPIDER_READY)('trap 19, and determinism', () => {
  const script = (seat: JumpSeat, tick: ReturnType<typeof onGround>, i: number): void => {
    const phase = i % 300
    tick(phase < 120 ? 1 : phase < 200 ? 1 : 0, phase < 120 ? 1 : 0, phase < 60 ? 0.3 : 0)
    void seat
  }

  it("a second spider stepped beside the first does not move the first's charge", () => {
    const a = spider()
    const b = spider()
    const ta = onGround(a)
    const tb = onGround(b)
    for (let i = 0; i < ticks(0.4); i++) ta(1, 1)
    const charge = a.jump?.charge
    for (let i = 0; i < ticks(0.4); i++) tb(1, 1)
    tb(1, 0)
    expect(b.jump?.jumps).toBe(1)
    expect(a.jump?.charge).toBe(charge)
    expect(a.jump?.jumps).toBe(0)
  })

  it('the same inputs twice give the same run, to the bit', () => {
    const fly = () => {
      const seat = spider()
      const tick = onGround(seat)
      for (let i = 0; i < 2400; i++) script(seat, tick, i)
      const b = seat.body
      return [b.position.x, b.position.y, b.position.z, b.velocity.y, seat.fuel, seat.jump?.jumps]
    }
    const first = fly()
    expect(first[5]).toBeGreaterThanOrEqual(2)
    expect(fly()).toEqual(first)
  })
})

// ── 8. a dry spider strands like any seat ─────────────────────────────────

describe.skipIf(!SPIDER_READY)("DEV-342's stranded rule, unchanged by the jump (§4.4)", () => {
  it('a dry spider on the ground is stranded on the same clock as a dry standard seat', () => {
    const SPEC: StrandedSpec = { restSeconds: 3, verticalSpeed: 2, holdSeconds: 1 }
    const tickToDying = (seat: JumpSeat, both: boolean): number => {
      const tick = onGround(seat)
      seat.fuel = 0
      const state = createStranded()
      const refuel = createRefuel([])
      for (let i = 0; i < ticks(10); i++) {
        tick(both ? 1 : 0, both ? 1 : 0)
        stepJumpSeatStranded(state, seat, refuel, SPEC, FIXED_DT)
        if (state.phase === 'dying') return i
      }
      return -1
    }
    const standard = tickToDying(createJumpSeat(), false)
    expect(standard).toBeGreaterThan(0)
    // The spider holding both triggers the whole time: no charge, same clock.
    expect(tickToDying(spider(), true)).toBe(standard)
  })
})

// ── 9. a pad's underside ──────────────────────────────────────────────────

describe('a seat under a floating pad is under it, not inside it (belowField)', () => {
  const pad = (): HeightField =>
    buildPadField({
      centre: { x: 500, y: GROUND + 120, z: 500 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      symmetry: 8,
      profile: [
        [0, 1],
        [20, 1],
      ],
      outer: 20,
      bottom: -1,
    })

  it('the hull passes under it: no push, no teleport', () => {
    const seat = createJumpSeat()
    seat.live = true
    seat.legs = null
    seat.body.position.x = 500
    seat.body.position.y = GROUND + 40
    seat.body.position.z = 500
    const collision = createTerrainCollision()
    const y0 = seat.body.position.y
    stepTerrainCollision(collision, seat.body, [FLAT, pad()], COLLISION, FIXED_DT)
    expect(seat.body.position.y).toBe(y0)
  })

  it('and a seat standing ON it still stands on it', () => {
    const seat = createJumpSeat()
    seat.live = true
    seat.body.position.x = 500
    seat.body.position.y = GROUND + 125
    seat.body.position.z = 500
    const collision = createTerrainCollision()
    const fields = [FLAT, pad()]
    for (let i = 0; i < 1200; i++) {
      stepJumpSeat(seat, noJumpSeatInput(), fields, FIXED_DT)
      stepTerrainCollision(collision, seat.body, fields, COLLISION, FIXED_DT)
    }
    expect(seat.body.position.y).toBeGreaterThan(GROUND + 121)
    expect(seat.body.position.y).toBeLessThan(GROUND + 124)
  })
})
