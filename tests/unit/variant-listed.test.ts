// tests/unit/variant-listed.test.ts — a variant can be NOT READY TO SHIP, and
// the jumping spider is. DEV-403.
//
// Matt, 2026-09-25, late: after the spider's hop planner could not fly all six
// JumpSeat courses clear of the head strike, *"let's abandon autopilot for the
// jumping spider"*, then *"mark the spider as not ready to ship - and mark any
// tests as not needing to test (skip them)"*. `listed: false` in
// `content/aircraft/jumpseat.json` is that mark, and `helpers/spider-ready.ts`
// is what every spider-only test skips on.
//
// This file is the LOUD half of that skip: it pins the flag, so the day the
// spider is made ready the first thing to go red is here, on purpose, and the
// skipped tests come back with it.

import { describe, expect, it } from 'vitest'
import {
  type Aircraft,
  listedVariants,
  STANDARD_VARIANT_ID,
  validateAircraft,
} from '@/content/aircraft-schema'
import { aircraftFor, resolveVariant } from '@/content/load-aircraft'
import { flightVariantRequest, rememberedVariant, VARIANT_CHOICE_KEY } from '@/game/variant-choice'
import { variantCards } from '@/game/variant-stats'
import { SPIDER_READY } from './helpers/spider-ready'

const ANNIVERSARY = { gameplay: { variants: { enabled: true } } }

/** A store holding one remembered choice per aircraft, as the hangar writes it. */
const storeWith = (choices: Record<string, string>) => {
  const raw = JSON.stringify(choices)
  return { getItem: (key: string) => (key === VARIANT_CHOICE_KEY ? raw : null), setItem: () => {} }
}

describe('the jumping spider is NOT READY TO SHIP (Matt, 2026-09-25)', () => {
  const jumpseat = aircraftFor('jumpseat')

  it('is marked listed: false, and the spider tests skip on exactly that — flip here on purpose', () => {
    expect(jumpseat.variants.find((v) => v.id === 'spider')?.listed).toBe(false)
    expect(SPIDER_READY).toBe(false)
  })

  it('the hangar offers the JumpSeat without it, in file order', () => {
    expect(variantCards(jumpseat).map((c) => c.id)).toEqual([STANDARD_VARIANT_ID, 'overclocked'])
  })

  it('a player who picked it before flies standard: the remembered choice counts only among the offered', () => {
    const offered = listedVariants(jumpseat).map((v) => v.id)
    const known = jumpseat.variants.map((v) => v.id)
    const remembered = rememberedVariant('jumpseat', offered, storeWith({ jumpseat: 'spider' }))
    expect(remembered).toBeNull()
    expect(flightVariantRequest(null, known, undefined, remembered).source).toBe('none')
  })

  it('?variant=spider still flies it: a development switch, as ?mission= is for an unlisted course', () => {
    const known = jumpseat.variants.map((v) => v.id)
    expect(flightVariantRequest('spider', known, undefined, null)).toEqual({
      id: 'spider',
      source: 'pin',
    })
    const variant = resolveVariant('jumpseat', 'spider', ANNIVERSARY)
    expect(variant.id).toBe('spider')
    expect(variant.note).toBeNull()
  })

  it('every other aircraft offers every variant it has', () => {
    for (const vehicle of ['hoverjet', 'glider'] as const) {
      const aircraft = aircraftFor(vehicle)
      expect(listedVariants(aircraft), vehicle).toEqual(aircraft.variants)
    }
  })
})

describe('the validator reads listed', () => {
  const file = (listed: unknown, id = 'fast'): Aircraft =>
    ({
      vehicle: 'jumpseat',
      variants: [
        { id: STANDARD_VARIANT_ID, name: 'S', blurb: 'x', scale: {} },
        ...(id === STANDARD_VARIANT_ID ? [] : [{ id, name: 'F', blurb: 'x', scale: {}, listed }]),
      ],
    }) as unknown as Aircraft

  it('takes true, false, or nothing', () => {
    expect(() => validateAircraft(file(true))).not.toThrow()
    expect(() => validateAircraft(file(false))).not.toThrow()
    expect(() => validateAircraft(file(undefined))).not.toThrow()
  })

  it('refuses anything else', () => {
    expect(() => validateAircraft(file('no'))).toThrow(/listed must be true or false/)
  })

  it('refuses an unlisted standard: it is what every other choice falls back to', () => {
    const unlisted = {
      vehicle: 'jumpseat',
      variants: [{ id: STANDARD_VARIANT_ID, name: 'S', blurb: 'x', scale: {}, listed: false }],
    } as unknown as Aircraft
    expect(() => validateAircraft(unlisted)).toThrow(/cannot be unlisted/)
  })
})
