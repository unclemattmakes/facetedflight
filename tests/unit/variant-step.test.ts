// tests/unit/variant-step.test.ts — the hangar's variant step, without a room.
// DEV-382.
//
// docs/plan/AIRCRAFT-VARIANTS.md §6 and §9's DEV-382: a second pick after the
// aircraft, on Anniversary only; standard under the resting pointer; the
// choice remembered; records per variant. The room itself is three.js and a
// canvas, so how it LOOKS belongs to Playwright (`variant-step.spec.ts` walks
// title → hangar → aircraft → variant → plan → course and flies the choice).
// What lives here is every decision the step is made of that has no DOM in it,
// taken through the functions the room and `boot/app.ts` call:
//
//   · `stepsFor` / `hangarArcs` with `variantStep`, over the REAL editions —
//     the room's "is there a variant step" and the checklist's tree;
//   · `variantPages` — where each variant stands on the arc;
//   · `variantTables` / `withVariant` / `cardFor` — whose records a table
//     shows;
//   · `storedVariant` / `rememberVariant` — `ff2.variant.v1`;
//   · `variantBars` — the label's bars, against flights and the plan's own
//     measured table rather than against their own formula (trap 24).
//
// Only `standard` exists on `main` when this is written (DEV-381 and DEV-384
// add the rest), so the variants below are FIXTURES in the plan's shape: the
// real files are read too, and the assertions on them hold for any file the
// validator accepts.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Aircraft,
  type AircraftId,
  STANDARD_VARIANT_ID,
  validateAircraft,
} from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { aircraftFor } from '@/content/load-aircraft'
import { cardFor, type MissionCard, withVariant } from '@/game/mission-index'
import { bestKey } from '@/game/personal-best'
import {
  flightVariantRequest,
  rememberedVariant,
  rememberVariant,
  storedVariant,
  VARIANT_CHOICE_KEY,
} from '@/game/variant-choice'
import {
  barFill,
  type VariantCard,
  variantBars,
  variantCards,
  variantStep,
} from '@/game/variant-stats'
import {
  hangarArcs,
  hangarViews,
  SEAT_REST_BEARING,
  stepsFor,
  TABLE_BEARING_STEP,
  type TableSlot,
  tableBearings,
  type VariantTable,
  variantPages,
  variantTables,
} from '@/render/hangar'

const REPO = process.cwd()
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8')) as T
const ANNIVERSARY = readJson<Edition>('content/editions/anniversary.json')
const CLASSIC = readJson<Edition>('content/editions/classic.json')

/** The thirteen shipped missions (and any listed authored course), as cards with no store. */
const realCards = (): readonly MissionCard[] => {
  const dir = path.join(REPO, 'content', 'levels')
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort()
    .map((f) => cardFor(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Level, null))
}

/** The plan's §2.2 HoverJet, as a fixture: nimble, 2016, fast, in that file order. */
const HOVERJET_FIXTURE: Aircraft = validateAircraft(
  {
    vehicle: 'hoverjet',
    variants: [
      {
        id: 'acrobat',
        name: 'Acrobat',
        blurb: 'More nimble',
        scale: {
          'ship.rollRate': 1.8,
          'ship.pitchRate': 1.6,
          'ship.yawRate': 1.5,
          'rigidbody.angularDrag': 1.3,
          'ship.maxSpeed': 0.92,
        },
      },
      { id: 'standard', name: 'Standard', blurb: "2016's HoverJet", scale: {} },
      {
        id: 'speed',
        name: 'Speed',
        blurb: 'Faster top speed. Insane boost',
        scale: { 'ship.maxSpeed': 1.2, 'ship.boostMultiplier': 1.5, 'ship.rollRate': 0.9 },
      },
    ],
  },
  'fixture/hoverjet',
)

/** The JumpSeat with the spider (DEV-383) and no overclocked yet: one side filled. */
const JUMPSEAT_FIXTURE: Aircraft = validateAircraft(
  {
    vehicle: 'jumpseat',
    variants: [
      {
        id: 'spider',
        name: 'Jumping Spider',
        blurb: 'Charge a jump',
        scale: { 'thruster.thrustForce': 0.6, 'fuel.burnRate': 0.6 },
      },
      { id: 'standard', name: 'Standard', blurb: "2016's JumpSeat", scale: {} },
    ],
  },
  'fixture/jumpseat',
)

const FIXTURES: Readonly<Record<AircraftId, Aircraft>> = {
  hoverjet: HOVERJET_FIXTURE,
  jumpseat: JUMPSEAT_FIXTURE,
  // DEV-399: the real file — one variant, standard, until G5.
  glider: aircraftFor('glider'),
}

/** The step `boot/app.ts` builds, over an edition and the fixtures. */
const stepOn = (edition: Edition, lastFlown: string | null = null) =>
  variantStep(
    () => edition,
    (vehicle) => FIXTURES[vehicle],
    () => lastFlown,
  )

/** An in-memory `localStorage`. */
const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}
const hostile = {
  getItem: (): string | null => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
  setItem: (): void => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
}

const tablesOf = (cards: readonly VariantCard[]): readonly VariantTable[] =>
  cards.map((variant) => ({ variant, courses: 0, flown: 0, lastFlown: false }))

/** Where each variant id stands on its step's first page, in radians. */
const bearingsById = (pages: readonly (readonly (TableSlot | null)[])[]): Map<string, number> => {
  const row = pages[0] ?? []
  const bearings = tableBearings(row.length)
  const out = new Map<string, number>()
  row.forEach((slot, i) => {
    if (slot?.kind === 'variant') out.set(slot.variant.id, bearings[i] as number)
  })
  return out
}

/* ───────────────────────────────────────── Classic skips the step ─────── */

describe('the variant step exists on Anniversary only', () => {
  it('Anniversary walks five steps below an aircraft, Classic 2016s four', () => {
    expect(stepsFor(stepOn(ANNIVERSARY), 'hoverjet')).toEqual([
      'vehicles',
      'variants',
      'modes',
      'ranks',
      'courses',
    ])
    expect(stepsFor(stepOn(CLASSIC), 'hoverjet')).toEqual(['vehicles', 'modes', 'ranks', 'courses'])
    expect(stepsFor(stepOn(CLASSIC), 'jumpseat')).toEqual(hangarViews(false))
    // No step handed in at all is 2016's four too: every room built before
    // DEV-382, and the launch room.
    expect(stepsFor(null, 'hoverjet')).toEqual(hangarViews(false))
  })

  it("deals Classic's tree exactly as it was, and Anniversary's with a variant arc per aircraft", () => {
    const cards = realCards()
    // Classic: not one arc differs from the tree dealt with no step at all.
    expect(hangarArcs(cards, stepOn(CLASSIC))).toEqual(hangarArcs(cards))
    const arcs = hangarArcs(cards, stepOn(ANNIVERSARY))
    const variantArcs = arcs.filter((a) => a.view === 'variants')
    expect(variantArcs.map((a) => a.path)).toEqual([['hoverjet'], ['jumpseat']])
    // Below it the variant is on the path, and the plans' BACK says VARIANT.
    const plans = arcs.filter((a) => a.view === 'modes')
    expect(plans.every((a) => a.backWord === 'VARIANT')).toBe(true)
    expect(plans.map((a) => a.path.join('/'))).toContain('hoverjet/speed')
    expect(variantArcs.every((a) => a.backWord === 'AIRCRAFT')).toBe(true)
  })

  it('takes the step away from an aircraft with no variants file, not the whole room', () => {
    const step = variantStep(
      () => ANNIVERSARY,
      (vehicle) => {
        if (vehicle === 'jumpseat') throw new Error('no file')
        return HOVERJET_FIXTURE
      },
      () => null,
    )
    expect(stepsFor(step, 'hoverjet')).toContain('variants')
    expect(stepsFor(step, 'jumpseat')).toEqual(hangarViews(false))
  })

  it('reads the shipped aircraft files, which every edition-on room shows', () => {
    // Today each is `standard` alone; the step still shows it (no skip).
    for (const vehicle of ['hoverjet', 'jumpseat'] as const) {
      const step = variantStep(
        () => ANNIVERSARY,
        aircraftFor,
        () => null,
      )
      const ids = step.cardsFor(vehicle).map((c) => c.id)
      expect(ids).toContain(STANDARD_VARIANT_ID)
      expect(stepsFor(step, vehicle)).toContain('variants')
    }
  })
})

/* ────────────────────────────────── standard under the resting pointer ── */

describe('standard stands under the resting pointer, nimble left and fast right', () => {
  it('on the plan fixture, the plan bearings: -45 / -15 / +15', () => {
    const at = bearingsById(variantPages(tablesOf(variantCards(HOVERJET_FIXTURE))))
    expect(at.get('standard')).toBeCloseTo(SEAT_REST_BEARING, 12)
    expect(at.get('acrobat')).toBeCloseTo(SEAT_REST_BEARING - TABLE_BEARING_STEP, 12)
    expect(at.get('speed')).toBeCloseTo(SEAT_REST_BEARING + TABLE_BEARING_STEP, 12)
  })

  it('with one side filled, the side stays its side and standard stays put', () => {
    // A spider and no overclocked: the spider is LEFT of standard, not under
    // the pointer, which an unpadded pair would have done.
    const spider = bearingsById(variantPages(tablesOf(variantCards(JUMPSEAT_FIXTURE))))
    expect(spider.get('standard')).toBeCloseTo(SEAT_REST_BEARING, 12)
    expect(spider.get('spider')).toBeCloseTo(SEAT_REST_BEARING - TABLE_BEARING_STEP, 12)
    const fastOnly = variantCards({
      vehicle: 'hoverjet',
      variants: [
        HOVERJET_FIXTURE.variants[1],
        HOVERJET_FIXTURE.variants[2],
      ] as Aircraft['variants'],
    })
    const fast = bearingsById(variantPages(tablesOf(fastOnly)))
    expect(fast.get('standard')).toBeCloseTo(SEAT_REST_BEARING, 12)
    expect(fast.get('speed')).toBeCloseTo(SEAT_REST_BEARING + TABLE_BEARING_STEP, 12)
  })

  it('on the SHIPPED files, whatever they hold', () => {
    for (const vehicle of ['hoverjet', 'jumpseat'] as const) {
      const at = bearingsById(variantPages(tablesOf(variantCards(aircraftFor(vehicle)))))
      expect(at.get(STANDARD_VARIANT_ID), vehicle).toBeCloseTo(SEAT_REST_BEARING, 12)
    }
  })
})

/* ──────────────────────────────────────────── records are per variant ── */

describe('a table shows the records of the variant it stands for', () => {
  const RA = 'ringAttack'
  const run = (score: number) => JSON.stringify({ score, timeSeconds: 60, gates: 21, setAt: 0 })

  it("re-reads the aircraft's cards under a variant, and leaves the other aircraft alone", () => {
    const store = memory({
      [bestKey('int_01_hoverJet', RA)]: run(1500),
      [bestKey('int_02_hoverJet', RA, 'speed')]: run(3000),
    })
    const cards = realCards()
    const speed = withVariant(cards, 'hoverjet', 'speed', store)
    const int01 = speed.find((c) => c.id === 'int_01_hoverJet') as MissionCard
    const int02 = speed.find((c) => c.id === 'int_02_hoverJet') as MissionCard
    expect(int01.best, "the standard's 1500 is not the speed variant's").toBeNull()
    expect(int01.medal).toBeNull()
    expect(int02.best?.score).toBe(3000)
    expect(int02.variant).toBe('speed')
    // The medal off the course's own, SHARED thresholds (§7): 3000 on int_02.
    const standard02 = cardFor(
      JSON.parse(
        fs.readFileSync(path.join(REPO, 'content/levels/int_02_hoverJet.json'), 'utf8'),
      ) as Level,
      memory({ [bestKey('int_02_hoverJet', RA)]: run(3000) }),
    )
    expect(int02.medal).toBe(standard02.medal)
    expect(int02.medal).not.toBeNull()
    // A JumpSeat card is the same object: its records are not the HoverJet's.
    for (const [i, c] of cards.entries()) {
      if (c.vehicle === 'jumpseat') expect(speed[i]).toBe(c)
    }
  })

  it('counts each variant table on its own records, and marks the last flown', () => {
    const store = memory({
      [bestKey('int_01_hoverJet', RA)]: run(1500),
      [bestKey('int_02_hoverJet', RA)]: run(1500),
      [bestKey('int_02_hoverJet', RA, 'speed')]: run(3000),
    })
    const cards = realCards()
    const tables = variantTables(cards, 'hoverjet', variantCards(HOVERJET_FIXTURE), 'speed', store)
    const byId = new Map(tables.map((t) => [t.variant.id, t]))
    const courses = cards.filter((c) => c.vehicle === 'hoverjet').length
    expect(byId.get('standard')).toMatchObject({ flown: 2, courses, lastFlown: false })
    expect(byId.get('speed')).toMatchObject({ flown: 1, courses, lastFlown: true })
    expect(byId.get('acrobat')).toMatchObject({ flown: 0, courses, lastFlown: false })
  })

  it("reads only the standard's records from a card built with none named", () => {
    const store = memory({ [bestKey('int_01_hoverJet', RA, 'speed')]: run(3000) })
    const level = JSON.parse(
      fs.readFileSync(path.join(REPO, 'content/levels/int_01_hoverJet.json'), 'utf8'),
    ) as Level
    expect(cardFor(level, store).best).toBeNull()
    expect(cardFor(level, store).variant).toBe(STANDARD_VARIANT_ID)
    expect(cardFor(level, store, 'speed').best?.score).toBe(3000)
  })
})

/* ───────────────────────────────────────────────── the choice persists ── */

describe('ff2.variant.v1 — the variant each aircraft last flew', () => {
  const KNOWN = ['acrobat', 'standard', 'speed']

  it('round-trips per aircraft, keeping the others', () => {
    const store = memory()
    rememberVariant('hoverjet', 'speed', store)
    rememberVariant('jumpseat', 'standard', store)
    expect(storedVariant('hoverjet', KNOWN, store)).toBe('speed')
    expect(storedVariant('jumpseat', KNOWN, store)).toBe('standard')
    expect(JSON.parse(store.map.get(VARIANT_CHOICE_KEY) as string)).toEqual({
      hoverjet: 'speed',
      jumpseat: 'standard',
    })
  })

  it('remembers NOTHING on a first visit, which LAST FLOWN must not call standard', () => {
    // The first photographs of the step said STANDARD · LAST FLOWN in a fresh
    // profile: the label read the flight's fallback. What was flown is null
    // until something is; what flies is standard.
    expect(rememberedVariant('hoverjet', KNOWN, memory())).toBeNull()
    expect(rememberedVariant('hoverjet', KNOWN, hostile)).toBeNull()
    expect(storedVariant('hoverjet', KNOWN, memory())).toBe('standard')
    const store = memory()
    rememberVariant('hoverjet', 'speed', store)
    expect(rememberedVariant('hoverjet', KNOWN, store)).toBe('speed')
    expect(rememberedVariant('jumpseat', KNOWN, store)).toBeNull()
  })

  it('reads standard from a store that throws, garbage, or an id the file no longer has', () => {
    expect(storedVariant('hoverjet', KNOWN, hostile)).toBe('standard')
    expect(() => rememberVariant('hoverjet', 'speed', hostile)).not.toThrow()
    expect(storedVariant('hoverjet', KNOWN, memory({ [VARIANT_CHOICE_KEY]: '{not json' }))).toBe(
      'standard',
    )
    expect(storedVariant('hoverjet', KNOWN, memory({ [VARIANT_CHOICE_KEY]: '["speed"]' }))).toBe(
      'standard',
    )
    const removed = memory({ [VARIANT_CHOICE_KEY]: JSON.stringify({ hoverjet: 'overdrive' }) })
    expect(storedVariant('hoverjet', KNOWN, removed)).toBe('standard')
    expect(storedVariant('hoverjet', KNOWN, null)).toBe('standard')
  })
})

/* ─────────────────────────────────────────────────── the label's bars ── */

describe("a variant's bars are its machine against 2016's", () => {
  it("puts every one of standard's bars on the middle mark", () => {
    for (const vehicle of ['hoverjet', 'jumpseat'] as const) {
      for (const bar of variantBars(vehicle, {})) {
        expect(barFill(bar), `${vehicle} ${bar.label}`).toBeCloseTo(0.5, 12)
      }
    }
  })

  it("matches the plan's measured JumpSeat figures, which came off the step functions", () => {
    // AIRCRAFT-VARIANTS §1.4 and §3.2: terminal climb 16.14 m/s, free fall
    // 48.8, and the spider (thrust x 0.6) descending at 1.8 on full throttle.
    const [lift, drop] = variantBars('jumpseat', {})
    expect(lift?.value).toBeCloseTo(16.14, 2)
    expect(drop?.value).toBeCloseTo(48.8, 1)
    const [spiderLift] = variantBars('jumpseat', { 'thruster.thrustForce': 0.6 })
    expect(spiderLift?.value).toBeCloseTo(-1.8, 1)
    expect(barFill(spiderLift as NonNullable<typeof spiderLift>)).toBe(0)
  })

  it("moves the speed variant's TOP SPEED and BOOST by its thrust, and HANDLING by its roll", () => {
    const [speed, boost, handling] = variantBars('hoverjet', {
      'ship.maxSpeed': 1.2,
      'ship.boostMultiplier': 1.5,
      'ship.rollRate': 0.9,
    })
    expect(barFill(speed as NonNullable<typeof speed>)).toBeCloseTo(0.6, 9)
    expect(barFill(boost as NonNullable<typeof boost>)).toBeCloseTo(0.9, 9)
    expect(barFill(handling as NonNullable<typeof handling>)).toBeCloseTo(0.45, 9)
  })
})

/* ───────────────────────────────── which variant a flight is built from ── */

describe('flightVariantRequest — the pin, the hangar, the last flown', () => {
  const KNOWN = ['acrobat', 'standard', 'speed']

  it('lets ?variant= win over the hangar and the store, for an aircraft that has it', () => {
    // DEV-380's switch on a direct `?mission=` boot, whatever table the walk
    // then presses. DEV-382 first put the board ahead of it, and completion's
    // three variant runs flew standard.
    expect(flightVariantRequest('speed', KNOWN, 'standard', 'acrobat')).toEqual({
      id: 'speed',
      source: 'pin',
    })
  })

  it('lets a pin the aircraft lacks fall through, and the board beat the store', () => {
    expect(flightVariantRequest('overclocked', KNOWN, 'acrobat', 'speed')).toEqual({
      id: 'acrobat',
      source: 'hangar',
    })
    expect(flightVariantRequest(null, KNOWN, undefined, 'speed')).toEqual({
      id: 'speed',
      source: 'last flown',
    })
    expect(flightVariantRequest(null, KNOWN, undefined, 'gone')).toEqual({
      id: null,
      source: 'none',
    })
  })
})
