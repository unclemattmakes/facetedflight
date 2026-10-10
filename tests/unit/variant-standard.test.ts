// tests/unit/variant-standard.test.ts — `standard` IS 2016, bit for bit. DEV-380.
//
// docs/plan/AIRCRAFT-VARIANTS.md §2.3 and §9.1 (a). The variant layer's whole
// promise is that a player who never touches it flies the shipped game: the
// sheet stays 2016's, a variant is a VIEW of it, and `standard`'s view is the
// sheet because its scale is empty.
//
// The expectation is RECORDED, not re-derived (trap 24). The fixture was made
// by flying `helpers/variant-flight.ts`'s frozen script through the vehicle
// code at `recordedAt`, before DEV-380 gave `createHoverJet` / `createJumpSeat`
// a sheet parameter and moved the tank's reads onto it. Comparing
// `createHoverJet()` against `createHoverJet(standardView)` on the fly would
// agree with itself through any refactor that moved every bit at once; this
// compares both against a flight that was flown before the refactor existed.
//
// Proved red by having `standardScale` hand back `{"ship.rollRate": 1.0001}`
// for the jet and `{"fuel.burnRate": 1.0001}` for the seat: one part in ten
// thousand on one key moves both flights off the recording, which is the
// resolution "bit for bit" claims. (A `standard` carrying that scale in its
// JSON never gets this far: `validateAircraft` refuses it at load, and
// `variant-data.test.ts` proves that half.)
//
// **DEV-530 re-recorded the JumpSeat half** (`jumpseatRecordedAt`), because it
// moved the seat's physics on purpose: the legs stand on their capsules'
// composed frames, not on a disabled foot box. The chain still holds. At
// e1089817 the code reproduced f08e12e's JumpSeat flight bit for bit, so the
// DEV-380 refactor had moved nothing; DEV-530's diff to the code this script
// runs is `createJumpSeatLegSpecs` alone, which reads the sheet directly and
// never the view (`variant-sheet-reads.test.ts` lists it as a fixed read), so
// it cannot make the view and the sheet agree where they did not.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import { aircraftFor, resolveVariant } from '@/content/load-aircraft'
import { HOVERJET, JUMPSEAT } from '@/generated/constants.generated'
import { energySpec } from '@/sim/energy'
import { energyRaceSpec } from '@/sim/energy-race'
import { createHoverJet, hoverJetView } from '@/sim/hoverjet'
import { createJumpSeat, jumpSeatView } from '@/sim/jumpseat'
import {
  type Fingerprint,
  flyHoverJetScript,
  flyJumpSeatScript,
  SCRIPT_RACE_DRAIN,
  SCRIPT_RACE_PAY,
  SCRIPT_RECHARGE_SCALE,
} from './helpers/variant-flight'

const RECORDED = JSON.parse(
  fs.readFileSync('tests/unit/fixtures/variant-standard-trajectory.json', 'utf8'),
) as {
  recordedAt: string
  jumpseatRecordedAt: string
  hoverjet: Fingerprint
  jumpseat: Fingerprint
}

const ANNIVERSARY = { gameplay: { variants: { enabled: true } } }

/** The standard the CONTENT resolves: the path the game takes, not a hand-built `{}`. */
const standardScale = (vehicle: 'hoverjet' | 'jumpseat') => {
  const v = resolveVariant(vehicle, STANDARD_VARIANT_ID, ANNIVERSARY)
  expect(v.id).toBe(STANDARD_VARIANT_ID)
  return v.scale
}

const flyJet = (view: ReturnType<typeof hoverJetView> | undefined): Fingerprint =>
  view
    ? flyHoverJetScript(
        createHoverJet(view),
        energySpec(SCRIPT_RECHARGE_SCALE, view),
        energyRaceSpec(SCRIPT_RACE_DRAIN, SCRIPT_RACE_PAY, view),
      )
    : flyHoverJetScript(
        createHoverJet(),
        energySpec(SCRIPT_RECHARGE_SCALE),
        energyRaceSpec(SCRIPT_RACE_DRAIN, SCRIPT_RACE_PAY),
      )

describe('standard is 2016, bit for bit, over a recorded flight', () => {
  it(`the recording is the pre-DEV-380 code's (${RECORDED.recordedAt})`, () => {
    // The guard on the guard: a fixture with no provenance, or one re-recorded
    // from the code it is meant to be checking, proves nothing.
    expect(RECORDED.recordedAt).toBe('f08e12e')
    // The JumpSeat half, re-recorded by DEV-530 (see the header).
    expect(RECORDED.jumpseatRecordedAt).toBe('e1089817+DEV-530')
    expect(RECORDED.hoverjet.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(RECORDED.jumpseat.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the content has a standard, on both aircraft, and it scales nothing', () => {
    expect(aircraftFor('hoverjet').variants.map((v) => v.id)).toContain(STANDARD_VARIANT_ID)
    expect(aircraftFor('jumpseat').variants.map((v) => v.id)).toContain(STANDARD_VARIANT_ID)
    expect(standardScale('hoverjet')).toEqual({})
    expect(standardScale('jumpseat')).toEqual({})
  })

  it("standard's view of the sheet IS the sheet — the same object, not an equal copy", () => {
    expect(hoverJetView(standardScale('hoverjet'))).toBe(HOVERJET)
    expect(jumpSeatView(standardScale('jumpseat'))).toBe(JUMPSEAT)
    expect(createHoverJet().sheet).toBe(HOVERJET)
  })

  it('a HoverJet built from no argument flies the recorded flight', () => {
    const got = flyJet(undefined)
    expect(got.samples).toEqual(RECORDED.hoverjet.samples)
    expect(got.sha256).toBe(RECORDED.hoverjet.sha256)
  })

  it("a HoverJet built from standard's view — jet AND tank — flies the recorded flight", () => {
    const got = flyJet(hoverJetView(standardScale('hoverjet')))
    expect(got.samples).toEqual(RECORDED.hoverjet.samples)
    expect(got.sha256).toBe(RECORDED.hoverjet.sha256)
  })

  it('a JumpSeat built from no argument flies the recorded flight', () => {
    const got = flyJumpSeatScript(createJumpSeat())
    expect(got.samples).toEqual(RECORDED.jumpseat.samples)
    expect(got.sha256).toBe(RECORDED.jumpseat.sha256)
  })

  it("a JumpSeat built from standard's view flies the recorded flight", () => {
    const got = flyJumpSeatScript(createJumpSeat(jumpSeatView(standardScale('jumpseat'))))
    expect(got.samples).toEqual(RECORDED.jumpseat.samples)
    expect(got.sha256).toBe(RECORDED.jumpseat.sha256)
  })
})
