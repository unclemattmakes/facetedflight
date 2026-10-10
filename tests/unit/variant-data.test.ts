// tests/unit/variant-data.test.ts — aircraft variants as data. DEV-380.
//
// docs/plan/AIRCRAFT-VARIANTS.md §2 and §9.1. What is held here, each proved
// red against the thing it guards:
//
//  1. `scaleSheet` scales EXACTLY the named keys, by exactly their factors,
//     and writes nothing into the generated module. A test-only fixture
//     variant goes through the whole path — validator, resolver, view, the
//     jet, the tank — and every other number on the sheet comes out the same
//     object or the same bits. (Red: `createHoverJet` reading `HOVERJET.ship`
//     instead of its sheet.)
//  2. Every key a variant MAY scale moves its vehicle. Scaled by 2 on its own,
//     each one takes the frozen scripted flight off the recording of
//     `standard`. A key nothing reads is a menu that lies (DEV-069). (Red:
//     whitelist `ship.rollCompensationSpeed`, which nothing reads.)
//  3. The validator refuses what §2.2 says it refuses. (Red: the whitelist
//     check removed, and an unknown key sails through.)
//  4. Classic ignores the request: `gameplay.variants.enabled` false resolves
//     `standard` for an id Anniversary resolves. (Red: the edition check
//     removed from `resolveVariantIn`.)
//  5. The speed gauge's full scale for 2016's sheet is DEV-257's pinned
//     constant to the bit, so `standard`'s panel did not move.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  type Aircraft,
  AircraftSchemaError,
  PER_TICK_BLEED_KEYS,
  resolveVariantIn,
  STANDARD_VARIANT_ID,
  VARIANT_MECHANICS,
  VARIANT_SCALE_KEYS,
  validateAircraft,
} from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { aircraftFor, resolveVariant } from '@/content/load-aircraft'
import { courseGates } from '@/game/mission'
import { SPEED_GAUGE_CHAIN_GATES, speedGaugeFullScale } from '@/game/speed-gauge'
import { HOVERJET, JUMPSEAT } from '@/generated/constants.generated'
import { HUD_GAUGE_SPEED_FULL_SCALE } from '@/render/hud-gauges'
import { energySpec } from '@/sim/energy'
import { energyRaceSpec } from '@/sim/energy-race'
import { createHoverJet, type HoverJetSheet, hoverJetView } from '@/sim/hoverjet'
import { createJumpSeat, jumpSeatView } from '@/sim/jumpseat'
import { type SheetScale, SheetScaleError, scaleSheet, sheetValue } from '@/sim/variant'
import {
  type Fingerprint,
  flyHoverJetScript,
  flyJumpSeatScript,
  SCRIPT_RACE_DRAIN,
  SCRIPT_RACE_PAY,
  SCRIPT_RECHARGE_SCALE,
} from './helpers/variant-flight'

const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T
const ANNIVERSARY = readJson<Edition>('content/editions/anniversary.json')
const CLASSIC = readJson<Edition>('content/editions/classic.json')
const RECORDED = readJson<{ hoverjet: Fingerprint; jumpseat: Fingerprint }>(
  'tests/unit/fixtures/variant-standard-trajectory.json',
)

/** A variant that exists only here. Three keys, three different blocks of the sheet. */
const FIXTURE_SCALE: SheetScale = {
  'ship.rollRate': 1.8,
  'rigidbody.angularDrag': 1.3,
  'energy.BoostBurnrate': 1.5,
}
const FIXTURE: Aircraft = {
  vehicle: 'hoverjet',
  variants: [
    { id: 'fixture', name: 'Fixture', blurb: 'Test only', scale: FIXTURE_SCALE },
    { id: STANDARD_VARIANT_ID, name: 'Standard', blurb: '2016', scale: {} },
  ],
}

/** Every numeric leaf of a sheet, by dotted path (arrays by index). */
const numericLeaves = (node: unknown, at = '', out = new Map<string, number>()) => {
  if (typeof node === 'number') out.set(at, node)
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) numericLeaves(v, at ? `${at}.${k}` : k, out)
  }
  return out
}

const flyJetView = (view: HoverJetSheet): Fingerprint =>
  flyHoverJetScript(
    createHoverJet(view),
    energySpec(SCRIPT_RECHARGE_SCALE, view),
    energyRaceSpec(SCRIPT_RACE_DRAIN, SCRIPT_RACE_PAY, view),
  )

// ── 1. scaleSheet, and a fixture variant end to end ──────────────────────

describe('scaleSheet: a view, never an edit', () => {
  it('returns the sheet ITSELF for an empty scale', () => {
    expect(scaleSheet(HOVERJET, {})).toBe(HOVERJET)
  })

  it('applies two keys that share a parent, and copies only the paths it touched', () => {
    const view = scaleSheet(HOVERJET, { 'ship.rollRate': 2, 'ship.pitchRate': 3 })
    expect(view.ship.rollRate).toBe(HOVERJET.ship.rollRate * 2)
    expect(view.ship.pitchRate).toBe(HOVERJET.ship.pitchRate * 3)
    expect(view.ship).not.toBe(HOVERJET.ship)
    expect(view.rigidbody).toBe(HOVERJET.rigidbody)
    expect(view.camera).toBe(HOVERJET.camera)
  })

  it('writes nothing into the generated module', () => {
    const before = JSON.stringify([HOVERJET, JUMPSEAT])
    scaleSheet(HOVERJET, FIXTURE_SCALE)
    jumpSeatView({ 'thruster.thrustForce': 2, 'fuel.burnRate': 0.5 })
    expect(JSON.stringify([HOVERJET, JUMPSEAT])).toBe(before)
  })

  it('throws on a path that does not name a finite number', () => {
    expect(() => scaleSheet(HOVERJET, { 'ship.nope': 2 })).toThrow(SheetScaleError)
    expect(() => scaleSheet(HOVERJET, { 'nope.rollRate': 2 })).toThrow(SheetScaleError)
    expect(() => scaleSheet(HOVERJET, { ship: 2 })).toThrow(SheetScaleError)
    expect(() => scaleSheet(HOVERJET, { 'ship.rollRate': Number.NaN })).toThrow(SheetScaleError)
    // Own properties only: a path must not walk into the prototype.
    expect(() => scaleSheet(HOVERJET, { 'ship.constructor': 2 })).toThrow(SheetScaleError)
  })
})

describe('a fixture variant scales exactly the named keys', () => {
  const resolved = resolveVariantIn(validateAircraft(FIXTURE), 'fixture', ANNIVERSARY)
  const view = hoverJetView(resolved.scale)

  it('resolves on Anniversary', () => {
    expect(resolved.id).toBe('fixture')
    expect(resolved.note).toBeNull()
  })

  it('changes the named leaves by exactly their factors and no other leaf by a bit', () => {
    const base = numericLeaves(HOVERJET)
    const got = numericLeaves(view)
    expect([...got.keys()]).toEqual([...base.keys()])
    const moved: string[] = []
    for (const [p, b] of base) {
      const v = got.get(p) as number
      if (Object.hasOwn(FIXTURE_SCALE, p)) {
        expect(v, p).toBe(b * (FIXTURE_SCALE[p] as number))
        moved.push(p)
      } else if (!Object.is(v, b)) moved.push(`UNNAMED ${p}`)
    }
    expect(moved.sort()).toEqual(Object.keys(FIXTURE_SCALE).sort())
  })

  it('reaches the jet, its rigid body and its tank — and nothing else in them', () => {
    const jet = createHoverJet(view)
    const std = createHoverJet()
    expect(jet.sheet).toBe(view)
    expect(jet.tuning.rollRate).toBe(HOVERJET.ship.rollRate * 1.8)
    expect(jet.body.angularDrag).toBe(HOVERJET.rigidbody.angularDrag * 1.3)
    expect({ ...jet.tuning, rollRate: 0 }).toEqual({ ...std.tuning, rollRate: 0 })
    expect(jet.body.mass).toBe(std.body.mass)
    expect(jet.body.drag).toBe(std.body.drag)
    expect(jet.chainSpec).toEqual(std.chainSpec)
    expect(energySpec(SCRIPT_RECHARGE_SCALE, view).burnPerSecond).toBe(
      HOVERJET.energy.engineBurnrate * (HOVERJET.energy.BoostBurnrate * 1.5),
    )
    expect(energyRaceSpec(SCRIPT_RACE_DRAIN, SCRIPT_RACE_PAY, view).boostDrainPerSecond).toBe(
      HOVERJET.energy.engineBurnrate *
        SCRIPT_RACE_DRAIN *
        (1 + HOVERJET.energy.BoostBurnrate * 1.5),
    )
  })

  it('reaches the JumpSeat too, through the same door', () => {
    const seatView = jumpSeatView({ 'thruster.thrustForce': 0.6, 'orientation.rollRate': 1.25 })
    const seat = createJumpSeat(seatView)
    const std = createJumpSeat()
    expect(seat.tuning.thrustForce).toBe(JUMPSEAT.thruster.thrustForce * 0.6)
    expect(seat.tuning.rollRate).toBe(JUMPSEAT.orientation.rollRate * 1.25)
    expect({ ...seat.tuning, thrustForce: 0, rollRate: 0 }).toEqual({
      ...std.tuning,
      thrustForce: 0,
      rollRate: 0,
    })
    expect(seat.hoverSpec).toEqual(std.hoverSpec)
  })
})

// ── 2. every whitelisted key moves its vehicle ───────────────────────────

describe('every key a variant may scale MOVES its vehicle (DEV-069)', () => {
  for (const key of VARIANT_SCALE_KEYS.hoverjet) {
    it(`hoverjet: ${key} x 2 changes the scripted flight`, () => {
      const got = flyJetView(hoverJetView({ [key]: 2 }))
      expect(got.sha256, `${key} is whitelisted and nothing reads it`).not.toBe(
        RECORDED.hoverjet.sha256,
      )
    })
  }
  for (const key of VARIANT_SCALE_KEYS.jumpseat) {
    it(`jumpseat: ${key} x 2 changes the scripted flight`, () => {
      const got = flyJumpSeatScript(createJumpSeat(jumpSeatView({ [key]: 2 })))
      expect(got.sha256, `${key} is whitelisted and nothing reads it`).not.toBe(
        RECORDED.jumpseat.sha256,
      )
    })
  }

  it("no whitelisted key changes either tank's SIZE — the premise app.ts's unrouted sites rest on", () => {
    // `boot/app.ts` builds both tanks, pays gates into the race tank and draws
    // the gauge's fraction with 2016's sheet: only the two BURN sites take
    // `flight.jet.sheet`. That is correct exactly while no variant key moves
    // `maxEnergy` or `RebootTime`. The day one is whitelisted, this goes red,
    // and the fix is to pass `flight.jet.sheet` at those sites too.
    const std = energySpec(SCRIPT_RECHARGE_SCALE)
    const stdRace = energyRaceSpec(SCRIPT_RACE_DRAIN, SCRIPT_RACE_PAY)
    for (const key of VARIANT_SCALE_KEYS.hoverjet) {
      const view = hoverJetView({ [key]: 2 })
      const spec = energySpec(SCRIPT_RECHARGE_SCALE, view)
      const race = energyRaceSpec(SCRIPT_RACE_DRAIN, SCRIPT_RACE_PAY, view)
      expect(spec.maxEnergy, key).toBe(std.maxEnergy)
      expect(spec.lockoutSeconds, key).toBe(std.lockoutSeconds)
      expect(race.maxEnergy, key).toBe(stdRace.maxEnergy)
      expect(race.gatePay, key).toBe(stdRace.gatePay)
    }
  })
})

// ── 3. the validator ─────────────────────────────────────────────────────

const withVariant = (scale: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    vehicle: 'hoverjet',
    variants: [
      { id: STANDARD_VARIANT_ID, name: 'Standard', blurb: '2016', scale: {} },
      { id: 'probe', name: 'Probe', blurb: 'x', scale, ...extra },
    ],
  }) as unknown as Aircraft

const refuses = (a: Aircraft, words: RegExp) => {
  expect(() => validateAircraft(a, 'probe.json')).toThrow(AircraftSchemaError)
  expect(() => validateAircraft(a, 'probe.json')).toThrow(words)
}

describe('validateAircraft refuses what §2.2 says it refuses', () => {
  it('accepts the fixture and both real files', () => {
    expect(validateAircraft(FIXTURE)).toBe(FIXTURE)
    expect(() => resolveVariant('hoverjet', null, ANNIVERSARY)).not.toThrow()
    expect(() => resolveVariant('jumpseat', null, ANNIVERSARY)).not.toThrow()
  })

  it('refuses rigidbody.mass, a world key, an unwhitelisted sheet key and a typo', () => {
    refuses(withVariant({ 'rigidbody.mass': 1.1 }), /rigidbody\.mass.*not one a hoverjet variant/)
    refuses(withVariant({ 'world.gravity': 1.1 }), /world\.gravity/)
    refuses(withVariant({ 'ship.rollCompensationSpeed': 1.1 }), /rollCompensationSpeed/)
    refuses(withVariant({ 'ship.rolRate': 1.1 }), /rolRate/)
  })

  it('refuses a JumpSeat key on a HoverJet', () => {
    refuses(withVariant({ 'thruster.thrustForce': 1.1 }), /thruster\.thrustForce/)
  })

  it('refuses a factor of 0, -1, NaN, Infinity or a string', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
      refuses(withVariant({ 'ship.rollRate': bad }), /finite number above zero/)
    }
  })

  it('refuses a per-tick bleed pushed to 1 or above, and allows one just under', () => {
    const drift = HOVERJET.ship.driftMultiplier
    refuses(withVariant({ 'ship.driftMultiplier': Math.ceil(1 / drift) }), /per-tick bleed/)
    refuses(
      withVariant({ 'ship.liftMultiplier': Math.ceil(1 / HOVERJET.ship.liftMultiplier) }),
      /per-tick bleed/,
    )
    expect(() =>
      validateAircraft(withVariant({ 'ship.driftMultiplier': Math.floor(1 / drift) })),
    ).not.toThrow()
  })

  it('refuses a file with no standard, a standard that scales, and a duplicate id', () => {
    refuses(
      {
        vehicle: 'hoverjet',
        variants: [{ id: 'fast', name: 'Fast', blurb: 'x', scale: {} }],
      } as unknown as Aircraft,
      /no "standard"/,
    )
    refuses(
      {
        vehicle: 'hoverjet',
        variants: [
          { id: STANDARD_VARIANT_ID, name: 'S', blurb: 'x', scale: { 'ship.rollRate': 1.0001 } },
        ],
      } as unknown as Aircraft,
      /must scale nothing/,
    )
    refuses(
      {
        vehicle: 'hoverjet',
        variants: [
          { id: STANDARD_VARIANT_ID, name: 'S', blurb: 'x', scale: {} },
          { id: STANDARD_VARIANT_ID, name: 'S', blurb: 'x', scale: {} },
        ],
      } as unknown as Aircraft,
      /two variants/,
    )
  })

  it('refuses a mechanic no sim implements — the JumpSeat has gravityScale (DEV-384) and jump (DEV-383), nothing else', () => {
    expect(VARIANT_MECHANICS.hoverjet).toEqual([])
    expect(VARIANT_MECHANICS.jumpseat).toEqual(['gravityScale', 'jump'])
    // §11 answer 5 settled the spider's jump as surface-only: a double jump is
    // a mechanic nothing implements, and naming one is refused, not ignored.
    refuses(withVariant({}, { mechanics: { doubleJump: {} } }), /mechanics "doubleJump"/)
  })

  it('refuses an id that cannot be a storage key, an unknown vehicle, and no variants', () => {
    refuses(withVariant({}, { id: 'Speed' }), /lower-case/)
    refuses(withVariant({}, { id: 'a.b' }), /lower-case/)
    // Not the glider any more: DEV-399 made it an aircraft with a file.
    refuses({ vehicle: 'zeppelin', variants: [] } as unknown as Aircraft, /vehicle "zeppelin"/)
    refuses({ vehicle: 'hoverjet', variants: [] } as unknown as Aircraft, /non-empty/)
  })

  it('checks the whitelist itself against the real sheet', () => {
    // A whitelist typo would otherwise be a key every file is refused for, or
    // worse, one `scaleSheet` throws on at board time.
    const sheets = { hoverjet: HOVERJET, jumpseat: JUMPSEAT } as const
    for (const [vehicle, keys] of Object.entries(VARIANT_SCALE_KEYS)) {
      for (const key of keys) {
        const v = sheetValue(sheets[vehicle as keyof typeof sheets], key)
        expect(Number.isFinite(v), `${vehicle} ${key}`).toBe(true)
        expect(key).not.toBe('rigidbody.mass')
        expect(key.startsWith('world.')).toBe(false)
      }
    }
    for (const key of PER_TICK_BLEED_KEYS) expect(VARIANT_SCALE_KEYS.hoverjet).toContain(key)
  })
})

// ── 4. Classic ignores the request ───────────────────────────────────────

describe('Classic always flies standard; Anniversary flies what was asked', () => {
  it('the editions say so', () => {
    expect(ANNIVERSARY.gameplay.variants.enabled).toBe(true)
    expect(CLASSIC.gameplay.variants.enabled).toBe(false)
  })

  it('Classic resolves standard for an id Anniversary resolves, and says why', () => {
    const aircraft = validateAircraft(FIXTURE)
    expect(resolveVariantIn(aircraft, 'fixture', ANNIVERSARY).id).toBe('fixture')
    const classic = resolveVariantIn(aircraft, 'fixture', CLASSIC)
    expect(classic.id).toBe(STANDARD_VARIANT_ID)
    expect(classic.scale).toEqual({})
    expect(classic.note).toMatch(/ignored.*no aircraft variants/)
  })

  it('Classic asked for standard, or nothing, says nothing', () => {
    const aircraft = validateAircraft(FIXTURE)
    expect(resolveVariantIn(aircraft, STANDARD_VARIANT_ID, CLASSIC).note).toBeNull()
    expect(resolveVariantIn(aircraft, null, CLASSIC).note).toBeNull()
  })

  it('an unknown id flies standard with a note naming the ones there are, never a throw', () => {
    const r = resolveVariant('hoverjet', 'warp-drive', ANNIVERSARY)
    expect(r.id).toBe(STANDARD_VARIANT_ID)
    // The known list is the FILE's, read back rather than typed: it said
    // "Known: standard" until DEV-381 added the acrobat and the speed jet.
    const known = aircraftFor('hoverjet').variants.map((v) => v.id)
    expect(known).toContain(STANDARD_VARIANT_ID)
    expect(r.note).toContain('no variant "warp-drive"')
    expect(r.note).toContain(`Known: ${known.join(', ')}`)
    expect(resolveVariant('jumpseat', 'warp-drive', CLASSIC).id).toBe(STANDARD_VARIANT_ID)
  })
})

// ── 5. the speed gauge follows the jet, and standard's did not move ──────

describe("the speed gauge's full scale is the jet's own", () => {
  it("for 2016's sheet it is DEV-257's pinned constant, to the bit", () => {
    expect(speedGaugeFullScale(HOVERJET)).toBe(HUD_GAUGE_SPEED_FULL_SCALE)
  })

  it("is drawn for int_01's chain, counted off the course rather than typed", () => {
    const int01 = readJson<Level>('content/levels/int_01_hoverJet.json')
    expect(SPEED_GAUGE_CHAIN_GATES).toBe(courseGates(int01).length)
  })

  it('grows with a variant that goes faster, so its needle does not peg', () => {
    // The plan's speed variant (§3.1): thrust x 1.2, boost x 1.5, about 564 m/s
    // chained. Built here from the plan's factors as a FIXTURE, not as content.
    const fast = hoverJetView({ 'ship.maxSpeed': 1.2, 'ship.boostMultiplier': 1.5 })
    expect(speedGaugeFullScale(fast)).toBeGreaterThan(HUD_GAUGE_SPEED_FULL_SCALE * 1.6)
  })
})
