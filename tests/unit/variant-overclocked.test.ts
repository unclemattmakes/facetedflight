// tests/unit/variant-overclocked.test.ts — the JumpSeat's overclocked variant,
// and the per-seat gravity it falls with. DEV-384.
//
// Matt, 2026-09-24: *"standard's hover-jet is boosted so it's much stronger.
// falls faster."* docs/plan/AIRCRAFT-VARIANTS.md §3.2 and §9.1 DEV-384; §11
// open call 7 settled "falls faster" as a per-seat gravity scale, never an edit
// of the world's −32.
//
// ── Relationships, not values (trap 24) ─────────────────────────────────────
//
// Every flight assertion below compares the overclocked seat against the
// STANDARD seat flown the same way through the same step function, and the
// factors come out of the content file rather than being typed here. "Climbs
// harder" is a ratio of two measured terminals; "falls faster" is a ratio of
// two measured drops. A test that computed the expected climb from 1125/15 − 44.8
// would be the implementation written twice.
//
// ── What each describe is for ───────────────────────────────────────────────
//
//  1. the content, and the validator's half of the mechanic;
//  2. `standard` is untouched by the mechanic path — through the seam's own
//     `jumpSeatFor`, against DEV-380's RECORDED flight;
//  3. overclocked climbs harder and falls faster, measured;
//  4. the cushion: the hover equilibrium stays 2016's, and the seat parks on its
//     gear without its hull touching;
//  5. the world is not edited, and two seats of two variants do not share one
//     gravity (trap 19);
//  6. the six courses, flown headless by the JumpSeat autopilot (skips, loudly,
//     without `public/assets`).
//
// Proved red, each against the product rather than a fixture:
//  - (2) `jumpSeatFor` coercing the mechanic with `Number(...)`, which hands a
//    standard seat a NaN gravity;
//  - (3) the seat integrating the world's `GRAVITY` instead of `seat.gravity`:
//    the fall ratio reads 1.00;
//  - (4) `hoverMotor.hoverForce` dropped from overclocked's scale: the cushion
//    cannot carry the heavier seat and it sinks onto its hull;
//  - (5) `stepJumpSeat` handing the legs the world's gravity: an overclocked
//    seat's back feet lift above their hinges in free fall;
//  - (6) the plan's `fuel.burnRate` x1.3: rookie_02 and int_01 do not finish,
//    and int_01 takes 3 pads of 6. (The autopilot's world-gravity feed-forward
//    fails (6) too, on int_02; `variant-sheet-reads.test.ts` is its guard.)

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Aircraft,
  AircraftSchemaError,
  MECHANIC_FACTORS,
  STANDARD_VARIANT_ID,
  VARIANT_MECHANICS,
  validateAircraft,
} from '@/content/aircraft-schema'
import { aircraftFor, resolveVariant } from '@/content/load-aircraft'
import { jumpSeatFor } from '@/game/jumpseat-flight'
import { JUMPSEAT, WORLD } from '@/generated/constants.generated'
import { FIXED_DT, GRAVITY } from '@/sim/constants'
import {
  createJumpSeat,
  hoverEquilibriumHeight,
  type JumpSeat,
  noJumpSeatInput,
  stepJumpSeat,
} from '@/sim/jumpseat'
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
import { createValidator, type SchemaNode } from './helpers/json-schema'
import {
  flyJumpSeatMission,
  JUMPSEAT_MISSIONS,
  type JumpSeatRunResult,
  jumpSeatTerrainAvailable,
  loadJumpSeatLevel,
} from './helpers/jumpseat-run'
import { type Fingerprint, flyJumpSeatScript } from './helpers/variant-flight'

const ANNIVERSARY = { gameplay: { variants: { enabled: true } } }
const OVERCLOCKED = 'overclocked'

const variant = (id: string) => {
  const v = resolveVariant('jumpseat', id, ANNIVERSARY)
  expect(v.id, `the content resolves "${id}" rather than falling back`).toBe(id)
  return v
}

const RECORDED = JSON.parse(
  fs.readFileSync('tests/unit/fixtures/variant-standard-trajectory.json', 'utf8'),
) as { recordedAt: string; jumpseat: Fingerprint }

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

/** The ray marcher's bisection step, as `jumpseat.test.ts` derives it. */
const RAY_RESOLUTION = (2 * JUMPSEAT.hoverMotor.hoverHeight) / 16 / 2 ** 6
const DEG = 180 / Math.PI

// ── flights ───────────────────────────────────────────────────────────────

/** Live, no legs, no ground, no fuel limit: the seat's own vertical terminal. */
const terminalClimb = (seat: JumpSeat, throttle: number, boost: number): number => {
  seat.live = true
  seat.legs = null
  seat.burnsFuel = false
  seat.body.position.y = 100_000
  const input = { ...noJumpSeatInput(), throttle, boost }
  for (let i = 0; i < Math.round(20 / FIXED_DT); i++) stepJumpSeat(seat, input)
  return seat.body.velocity.y
}

/** Metres fallen from rest in `seconds`, throttle shut — the fall as it is FELT. */
const dropFromRest = (seat: JumpSeat, seconds: number): number => {
  seat.live = true
  seat.legs = null
  seat.body.position.y = 100_000
  const y0 = seat.body.position.y
  for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) stepJumpSeat(seat, noJumpSeatInput())
  return y0 - seat.body.position.y
}

interface Parked {
  settled: number
  worst: number
  hullStrikes: number
  load: number
  angles: number[]
  grounded: boolean[]
}

/** Drop onto flat ground from 3 m, legs on, throttle shut, and let it park. */
const park = (seat: JumpSeat, withLegs = true): Parked => {
  seat.live = true
  if (!withLegs) seat.legs = null
  seat.body.position.x = 500
  seat.body.position.y = GROUND + 3
  seat.body.position.z = 500
  const collision = createTerrainCollision()
  const tick = (): boolean => {
    stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
    const struck = stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
    seat.body.angularDrag = collisionAngularDrag(collision, COLLISION, seat.tuning.angularDrag)
    return struck
  }
  for (let i = 0; i < 1200; i++) tick()
  const settled = seat.body.position.y - GROUND
  let worst = 0
  let hullStrikes = 0
  for (let i = 0; i < 600; i++) {
    if (tick()) hullStrikes++
    worst = Math.max(worst, Math.abs(seat.body.position.y - GROUND - settled))
  }
  return {
    settled,
    worst,
    hullStrikes,
    load: seat.legs?.totalLoad ?? 0,
    angles: (seat.legs?.legs ?? []).map((l) => l.angle * DEG),
    grounded: (seat.legs?.legs ?? []).map((l) => l.grounded),
  }
}

/**
 * Gear off and NO hull collision, as `jumpseat.test.ts` measures 2016's: the
 * height the hover impulse alone holds the seat at. (With the hull on, a
 * legless seat sits on its belly at 0.61 m, above the 0.49 m equilibrium.)
 */
const hoverSettle = (seat: JumpSeat): { settled: number; worst: number } => {
  seat.live = true
  seat.legs = null
  seat.body.position.x = 500
  seat.body.position.y = GROUND + 3
  seat.body.position.z = 500
  for (let i = 0; i < 1500; i++) stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
  const settled = seat.body.position.y - GROUND
  let worst = 0
  for (let i = 0; i < 500; i++) {
    stepJumpSeat(seat, noJumpSeatInput(), [FLAT], FIXED_DT)
    worst = Math.max(worst, Math.abs(seat.body.position.y - GROUND - settled))
  }
  return { settled, worst }
}

// ── 1. the content, and the validator ─────────────────────────────────────

const JUMPSEAT_FILE = (): Aircraft =>
  JSON.parse(fs.readFileSync('content/aircraft/jumpseat.json', 'utf8')) as Aircraft

const withMechanics = (vehicle: 'hoverjet' | 'jumpseat', mechanics: Record<string, unknown>) =>
  ({
    vehicle,
    variants: [
      { id: STANDARD_VARIANT_ID, name: 'Standard', blurb: '2016', scale: {} },
      { id: 'probe', name: 'Probe', blurb: 'x', scale: {}, mechanics },
    ],
  }) as unknown as Aircraft

describe('overclocked is content, and gravityScale is a mechanic the validator knows', () => {
  it('is in the JumpSeat file, BELOW standard (the spider goes above, §6.2)', () => {
    const ids = aircraftFor('jumpseat').variants.map((v) => v.id)
    expect(ids).toContain(OVERCLOCKED)
    expect(ids.indexOf(OVERCLOCKED)).toBeGreaterThan(ids.indexOf(STANDARD_VARIANT_ID))
  })

  it('scales thrust, burn and the cushion, and carries a gravity scale — and scales nothing typed', () => {
    const oc = variant(OVERCLOCKED)
    // The keys, not the factors: the factors are the content's to change, and
    // the measured describes below are what hold them to Matt's sentence.
    expect(Object.keys(oc.scale).sort()).toEqual(
      ['fuel.burnRate', 'hoverMotor.hoverForce', 'thruster.thrustForce'].sort(),
    )
    expect(Object.keys(oc.mechanics)).toEqual(['gravityScale'])
    expect(oc.mechanics.gravityScale).toBeGreaterThan(1)
  })

  it('accepts gravityScale on the JumpSeat and refuses it on the HoverJet', () => {
    expect(VARIANT_MECHANICS.jumpseat).toContain('gravityScale')
    expect(VARIANT_MECHANICS.hoverjet).not.toContain('gravityScale')
    expect(() => validateAircraft(withMechanics('jumpseat', { gravityScale: 1.4 }))).not.toThrow()
    expect(() => validateAircraft(withMechanics('hoverjet', { gravityScale: 1.4 }))).toThrow(
      /mechanics "gravityScale" is not implemented for the hoverjet/,
    )
  })

  it('refuses a gravityScale of 0, -1, NaN, Infinity or a string', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1.4']) {
      const a = withMechanics('jumpseat', { gravityScale: bad })
      expect(() => validateAircraft(a, 'probe.json'), String(bad)).toThrow(AircraftSchemaError)
      expect(() => validateAircraft(a, 'probe.json'), String(bad)).toThrow(
        /gravityScale.*finite number above zero/,
      )
    }
    expect(MECHANIC_FACTORS).toContain('gravityScale')
  })

  it('refuses a standard that carries one: 2016 by construction', () => {
    const a = JUMPSEAT_FILE() as unknown as { variants: { id: string; mechanics?: unknown }[] }
    const std = a.variants.find((v) => v.id === STANDARD_VARIANT_ID) as { mechanics?: unknown }
    std.mechanics = { gravityScale: 1.4 }
    expect(() => validateAircraft(a as unknown as Aircraft, 'jumpseat.json')).toThrow(
      /standard is 2016 by construction and carries no mechanics/,
    )
  })

  it("each aircraft's mechanics in the schema are exactly VARIANT_MECHANICS", () => {
    // `aircraft-content.test.ts` holds the SCALE lists equal; this is the same
    // two-copies-and-a-test for the mechanics, which the schema began to name
    // with this row.
    const schema = JSON.parse(
      fs.readFileSync(path.join('content/aircraft', '_schema.json'), 'utf8'),
    ) as SchemaNode & { $defs: Record<string, SchemaNode> }
    for (const [vehicle, keys] of Object.entries(VARIANT_MECHANICS)) {
      const node = schema.$defs[`${vehicle}Mechanics`]
      expect(node, `$defs.${vehicle}Mechanics`).toBeDefined()
      expect(Object.keys(node?.properties ?? {}).sort(), vehicle).toEqual([...keys].sort())
    }
    // And the schema refuses a gravityScale of zero on its own.
    const validate = createValidator(schema)
    const a = JUMPSEAT_FILE() as unknown as { variants: { mechanics?: Record<string, number> }[] }
    const oc = a.variants.find((v) => v.mechanics) as { mechanics: Record<string, number> }
    oc.mechanics.gravityScale = 0
    const errs: string[] = []
    validate(schema.$defs.jumpseatFile as SchemaNode, a, 'jumpseat.json', errs)
    expect(errs.join('\n')).toContain('is not greater than 0')
  })
})

// ── 2. standard is untouched by the mechanic path ─────────────────────────

describe('standard, built by the seam, is still 2016 bit for bit', () => {
  it("its gravity IS the world's — the same object, not an equal copy", () => {
    const seat = jumpSeatFor(variant(STANDARD_VARIANT_ID))
    expect(seat.gravity).toBe(GRAVITY)
    expect(createJumpSeat().gravity).toBe(GRAVITY)
    expect(jumpSeatFor().gravity).toBe(GRAVITY)
  })

  it("flies DEV-380's recorded flight through `jumpSeatFor`", () => {
    // The recording predates DEV-380 AND this row (`recordedAt`), so it cannot
    // agree with the mechanic path by construction (trap 24). Its JumpSeat half
    // was re-recorded by DEV-530 for the legs alone, which read the sheet and
    // never the mechanic path (`variant-standard.test.ts`'s header).
    expect(RECORDED.recordedAt).toBe('f08e12e')
    const got = flyJumpSeatScript(jumpSeatFor(variant(STANDARD_VARIANT_ID)))
    expect(got.samples).toEqual(RECORDED.jumpseat.samples)
    expect(got.sha256).toBe(RECORDED.jumpseat.sha256)
  })

  it('and overclocked does NOT — the recording can tell the two apart', () => {
    const got = flyJumpSeatScript(jumpSeatFor(variant(OVERCLOCKED)))
    expect(got.sha256).not.toBe(RECORDED.jumpseat.sha256)
  })
})

// ── 3. much stronger, falls faster: measured ──────────────────────────────

describe('overclocked climbs harder and falls faster than standard, measured', () => {
  const std = () => jumpSeatFor(variant(STANDARD_VARIANT_ID))
  const oc = () => jumpSeatFor(variant(OVERCLOCKED))
  const g = () => variant(OVERCLOCKED).mechanics.gravityScale as number

  it('climbs at full throttle at least 1.5x as fast', () => {
    const s = terminalClimb(std(), 1, 0)
    const o = terminalClimb(oc(), 1, 0)
    expect(s).toBeGreaterThan(0)
    expect(o / s).toBeGreaterThanOrEqual(1.5)
  })

  it('climbs boosted at least 1.4x as fast', () => {
    const s = terminalClimb(std(), 1, 1)
    const o = terminalClimb(oc(), 1, 1)
    expect(s).toBeGreaterThan(0)
    expect(o / s).toBeGreaterThanOrEqual(1.4)
  })

  it('falls at least 1.3x as fast at terminal', () => {
    const s = terminalClimb(std(), 0, 0)
    const o = terminalClimb(oc(), 0, 0)
    expect(s).toBeLessThan(0)
    expect(o / s).toBeGreaterThanOrEqual(1.3)
  })

  it('falls faster from the FIRST second — by exactly its gravity scale', () => {
    // The reason the plan chose gravity over drag (open call 7): a player feels
    // a fall at its start. The two seats share every drag, so the fall is
    // linear in g and the ratio of the drops IS the ratio of the gravities: a
    // relationship, not a number somebody computed.
    const s = dropFromRest(std(), 1)
    const o = dropFromRest(oc(), 1)
    expect(s).toBeGreaterThan(0)
    expect(o / s).toBeGreaterThanOrEqual(1.3)
    expect(o / s).toBeCloseTo(g(), 6)
  })
})

// ── 4. the cushion ────────────────────────────────────────────────────────

describe('the cushion carries the heavier seat', () => {
  const withGravity = () =>
    aircraftFor('jumpseat').variants.filter((v) => v.mechanics?.gravityScale !== undefined)

  it('there is a variant with a gravity scale to hold to it', () => {
    expect(withGravity().map((v) => v.id)).toContain(OVERCLOCKED)
  })

  it("every variant with a gravityScale hovers at 2016's height — derived", () => {
    const shipped = hoverEquilibriumHeight(createJumpSeat())
    for (const v of withGravity()) {
      const seat = jumpSeatFor(variant(v.id))
      expect(seat.gravity.y, v.id).toBe(GRAVITY.y * (v.mechanics?.gravityScale as number))
      expect(hoverEquilibriumHeight(seat), v.id).toBeCloseTo(shipped, 9)
    }
  })

  it('and SETTLES there with nothing under it but the ground, and holds', () => {
    // `jumpseat.test.ts`'s measured check, on the variant: gear off, the height
    // the hover impulse alone holds the seat at.
    for (const v of withGravity()) {
      const shipped = hoverEquilibriumHeight(createJumpSeat())
      const hover = hoverSettle(jumpSeatFor(variant(v.id)))
      expect(Math.abs(hover.settled - shipped), v.id).toBeLessThan(2 * RAY_RESOLUTION)
      expect(hover.worst, v.id).toBeLessThan(2 * RAY_RESOLUTION)
    }
  })

  it('parks on its GEAR, hull clear of the ground, legs squatting inside what standard uses', () => {
    const std = park(jumpSeatFor(variant(STANDARD_VARIANT_ID)))
    const belly = park(jumpSeatFor(variant(STANDARD_VARIANT_ID)), false)
    for (const v of withGravity()) {
      const p = park(jumpSeatFor(variant(v.id)))
      // On all four feet, and the hull never touches in the settled window —
      // which is what "bottoming the legs" would look like.
      expect(p.grounded, v.id).toEqual([true, true, true, true])
      expect(p.hullStrikes, v.id).toBe(0)
      // Higher than a seat sitting on its hull by most of standard's margin.
      expect(p.settled - belly.settled, v.id).toBeGreaterThan(0.5 * (std.settled - belly.settled))
      // The gear takes more of a heavier seat, and still well short of the 30°
      // the standard's own parking test allows.
      expect(p.load, v.id).toBeGreaterThan(std.load)
      for (const a of p.angles) {
        expect(a, v.id).toBeGreaterThan(0)
        expect(a, v.id).toBeLessThan(30)
      }
      // And it holds there; a suspension that hunts passes a single sample.
      expect(p.worst, v.id).toBeLessThan(0.01)
    }
  })
})

// ── 5. the world is not edited, and each seat has its own ─────────────────

describe("the world's gravity stays -32, and a seat's gravity is its own", () => {
  it("building overclocked seats leaves the world's vector alone", () => {
    const before = { ...GRAVITY }
    for (let i = 0; i < 3; i++) jumpSeatFor(variant(OVERCLOCKED))
    expect({ ...GRAVITY }).toEqual(before)
    expect(GRAVITY.y).toBe(WORLD.gravity.y)
  })

  it("the legs fall with the seat: they feel the SEAT's gravity, not the world's", () => {
    // A leg feels gravity minus the chassis's acceleration (`jumpseat-legs.ts`).
    // Dropped from rest with the throttle shut, the chassis accelerates at
    // g − drag·v, so a leg feels drag·v, which is proportional to g: the
    // overclocked legs sag by about the gravity scale more, and in the same
    // direction. Fed the WORLD's gravity while the chassis falls at 1.4 of it,
    // a leg feels 12.8 m/s² pointing UP and swings its foot above its hinge.
    const backLegs = (seat: JumpSeat, seconds: number): number[] => {
      seat.body.position.y = 100_000
      for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
        stepJumpSeat(seat, noJumpSeatInput())
      }
      return (seat.legs?.legs ?? []).slice(0, 2).map((l) => l.angle)
    }
    const g = variant(OVERCLOCKED).mechanics.gravityScale as number
    for (const seconds of [0.25, 0.5, 1]) {
      const s = backLegs(jumpSeatFor(variant(STANDARD_VARIANT_ID)), seconds)
      const o = backLegs(jumpSeatFor(variant(OVERCLOCKED)), seconds)
      for (let i = 0; i < s.length; i++) {
        // +θ lifts the foot; a hanging leg sags to a negative angle.
        expect(s[i] as number, `standard at ${seconds}s`).toBeLessThan(0)
        expect(o[i] as number, `overclocked at ${seconds}s`).toBeLessThan(0)
        expect((o[i] as number) / (s[i] as number), `at ${seconds}s`).toBeCloseTo(g, 1)
      }
    }
  })

  it('gives each seat its own frozen vector', () => {
    const a = jumpSeatFor(variant(OVERCLOCKED))
    const b = jumpSeatFor(variant(OVERCLOCKED))
    expect(a.gravity).not.toBe(b.gravity)
    expect(Object.isFrozen(a.gravity)).toBe(true)
  })

  it('trap 19: a standard and an overclocked seat stepped together fly as they fly alone', () => {
    // Each seat keeps its own x, alone or together, so the only thing that
    // differs between the two runs is whether the other seat was stepped too.
    const fly = (seats: readonly { seat: JumpSeat; x: number }[], ticks: number): number[][] => {
      const runs = seats.map(({ seat, x }) => {
        seat.body.position.x = x
        seat.body.position.y = GROUND + 6
        seat.body.position.z = 500
        seat.live = true
        return { seat, collision: createTerrainCollision(), trail: [] as number[] }
      })
      for (let t = 0; t < ticks; t++) {
        const input = { ...noJumpSeatInput(), throttle: t % 300 < 150 ? 1 : 0 }
        for (const { seat, collision, trail } of runs) {
          stepJumpSeat(seat, input, [FLAT], FIXED_DT)
          stepTerrainCollision(collision, seat.body, [FLAT], COLLISION, FIXED_DT)
          trail.push(seat.body.position.y, seat.body.velocity.y, seat.legs?.totalLoad ?? 0)
        }
      }
      return runs.map((r) => r.trail)
    }
    const std = () => ({ seat: jumpSeatFor(variant(STANDARD_VARIANT_ID)), x: 480 })
    const oc = () => ({ seat: jumpSeatFor(variant(OVERCLOCKED)), x: 520 })
    const [stdTogether, ocTogether] = fly([std(), oc()], 900)
    const [stdAlone] = fly([std()], 900)
    const [ocAlone] = fly([oc()], 900)
    expect(stdTogether).toEqual(stdAlone)
    expect(ocTogether).toEqual(ocAlone)
    expect(ocTogether).not.toEqual(stdTogether)
  })
})

// ── 6. the six courses ────────────────────────────────────────────────────

const LEVELS = JUMPSEAT_MISSIONS.map((id) => loadJumpSeatLevel(id))
const available = LEVELS.every((level) => jumpSeatTerrainAvailable(level))

const runs = new Map<string, JumpSeatRunResult>()
const flyOverclocked = (id: string): JumpSeatRunResult => {
  const hit = runs.get(id)
  if (hit) return hit
  const result = flyJumpSeatMission(loadJumpSeatLevel(id), { variant: variant(OVERCLOCKED) })
  runs.set(id, result)
  return result
}

describe.skipIf(!available)('the JumpSeat autopilot finishes every course overclocked', () => {
  it('SKIP NOTICE', () => {
    // Reached only when the assets are present; the `skipIf` above is the loud
    // half, and vitest prints the whole describe as skipped without them —
    // `jumpseat-autopilot-missions.test.ts`'s arrangement, for the same runs.
    expect(available).toBe(true)
  })

  it('finishes all six, at the finish gate', () => {
    // AIRCRAFT-VARIANTS §11 open call 14's rule, applied to this variant: a
    // variant that can open a course it cannot finish is a trap in the menu.
    // The plan's burn x1.3 failed it on four of six; see DEVIATIONS DEV-384.
    for (const id of JUMPSEAT_MISSIONS) {
      const run = flyOverclocked(id)
      expect(run.finished, `${id}: ${run.padsHit}/${run.pads} at ${run.elapsed}s`).toBe(true)
      expect(run.padsHit, id).toBeGreaterThan(0)
    }
  }, 120_000)

  it('takes every pad on int_01_jumpSeat (the plan names this course)', () => {
    const run = flyOverclocked('int_01_jumpSeat')
    expect(run.padsHit).toBe(run.pads)
    expect(run.finishCrossed).toBe(true)
  }, 60_000)
})
