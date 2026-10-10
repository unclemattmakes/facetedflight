// src/game/variant-stats.ts — what a variant table says about its machine.
// DEV-382.
//
// docs/plan/AIRCRAFT-VARIANTS.md §6.2: *"The label carries the name, the blurb,
// and three short bars DERIVED from the variant's view, never typed ... each
// drawn against the standard's value at the bar's middle mark ... A pure
// `game/variant-stats.ts` computes them, so a retune moves the bars and the
// label cannot lie."*
//
// So every bar is a quantity the sim would produce, computed off the variant's
// VIEW of the sheet by the sim's own functions, and the standard's value comes
// from the same function over 2016's sheet. Nothing here is a number: a bar at
// 60 % is "1.2 x the standard", because the standard sits at the middle mark.
//
// The HoverJet's three (§6.2):
//
//   TOP SPEED  the unboosted cruise, `cruiseSpeed(view)`
//   BOOST      the same at full boost, `cruiseSpeed(view, maxSpeed x boost)`
//   HANDLING   the full-stick roll rate, `fullStickRate(rollRate, angularDrag)`
//
// The JumpSeat's two, until DEV-383 gives the spider its JUMP:
//
//   LIFT       the climb it settles at on full throttle, m/s — NEGATIVE on a
//              seat that cannot climb (the spider's weaker jet), drawn empty
//   DROP       the free fall it settles at with the throttle shut, on
//              2016's DragHack free-fall drag, m/s
//
// Both terminals are the fixed-step integrator's (`tickTerminalSpeed`), which
// reproduces the plan's measured 16.1 and 48.8 m/s, not the continuous algebra.
// DEV-384's `gravityScale` will have to reach DROP and LIFT: today every
// JumpSeat falls under the world's gravity, because no seat carries its own.

import {
  type Aircraft,
  type AircraftId,
  type AircraftVariant,
  gliderTuningOf,
  listedVariants,
  VARIANT_SCALE_KEYS,
  type VariantsEdition,
} from '@/content/aircraft-schema'
import { GRAVITY } from '@/sim/constants'
import { type GliderTuning, terminalDiveSpeed } from '@/sim/glider'
import { cruiseSpeed, type HoverJetSheet, hoverJetView } from '@/sim/hoverjet'
import { type JumpSeatSheet, jumpSeatView } from '@/sim/jumpseat'
import { fullStickRate } from '@/sim/rigidbody'
import { tickTerminalSpeed } from '@/sim/speed-chain'
import type { SheetScale } from '@/sim/variant'

/** One bar on a variant's label. */
export interface VariantBar {
  /** What the label prints over it, upper case. */
  readonly label: string
  /** The variant's value, in the bar's own unit. */
  readonly value: number
  /** 2016's value in the same unit: the bar's middle mark. */
  readonly standard: number
}

/**
 * How full a bar is drawn, 0..1: the standard at one half, twice it full, and
 * nothing at or below zero. A bar is a comparison with 2016, which is why it
 * has a middle mark and no scale of its own.
 */
export const barFill = (bar: VariantBar): number =>
  bar.standard > 0 ? Math.max(0, Math.min(1, bar.value / (2 * bar.standard))) : 0

const hoverJetValues = (sheet: HoverJetSheet): readonly [number, number, number] => [
  cruiseSpeed(sheet),
  cruiseSpeed(sheet, sheet.ship.maxSpeed * sheet.ship.boostMultiplier),
  fullStickRate(sheet.ship.rollRate, sheet.rigidbody.angularDrag),
]

const jumpSeatValues = (sheet: JumpSeatSheet): readonly [number, number] => {
  const mass = sheet.rigidbody.mass
  const weight = mass * Math.abs(GRAVITY.y)
  return [
    tickTerminalSpeed(sheet.thruster.thrustForce - weight, mass, sheet.rigidbody.drag),
    tickTerminalSpeed(weight, mass, sheet.dragHack.drag_freefall),
  ]
}

/**
 * The glider's three (DEV-399), in the HoverJet's words so every aircraft's
 * table reads the same way — the rocket IS the glider's boost, on the same
 * trigger:
 *
 *   TOP SPEED  the terminal dive, `terminalDiveSpeed` — nothing flies faster
 *   BOOST      the rocket's burst, `rocketThrust × rocketSeconds / mass`, m/s
 *              of velocity a full tank adds before drag takes any
 *   HANDLING   the full-stick roll rate, `fullStickRate`, as the jet's
 */
const gliderValues = (t: GliderTuning): readonly [number, number, number] => [
  terminalDiveSpeed(t),
  (t.rocketThrust * t.rocketSeconds) / t.mass,
  fullStickRate(t.rollRate, t.angularDrag),
]

/**
 * The label's bars for one variant of one aircraft, against that aircraft's
 * 2016 — or, for the glider, against its own `standard` (DEV-399): it has no
 * 2016 to compare with, and no sheet to view, so its numbers are its file's,
 * `aircraft` is required for it, and without one it has no bars rather than
 * bars that are the JumpSeat's. G1 flies one variant, so every glider bar sits
 * at its middle mark; G5's re-solved variants move them.
 */
export const variantBars = (
  vehicle: AircraftId,
  scale: SheetScale,
  aircraft?: Aircraft,
): readonly VariantBar[] => {
  if (vehicle === 'glider') {
    if (!aircraft?.tuning) return []
    // Every G1 variant flies the file's tuning (`gliderTuningOf`), so value
    // and standard are one computation; G5 gives the variant its own solve.
    const [dive, rocket, handling] = gliderValues(gliderTuningOf(aircraft))
    return [
      { label: 'TOP SPEED', value: dive, standard: dive },
      { label: 'BOOST', value: rocket, standard: rocket },
      { label: 'HANDLING', value: handling, standard: handling },
    ]
  }
  if (vehicle === 'hoverjet') {
    const [speed, boost, handling] = hoverJetValues(hoverJetView(scale))
    const [speed0, boost0, handling0] = hoverJetValues(hoverJetView({}))
    return [
      { label: 'TOP SPEED', value: speed, standard: speed0 },
      { label: 'BOOST', value: boost, standard: boost0 },
      { label: 'HANDLING', value: handling, standard: handling0 },
    ]
  }
  const [lift, drop] = jumpSeatValues(jumpSeatView(scale))
  const [lift0, drop0] = jumpSeatValues(jumpSeatView({}))
  return [
    { label: 'LIFT', value: lift, standard: lift0 },
    { label: 'DROP', value: drop, standard: drop0 },
  ]
}

/**
 * One table on the hangar's variant step: everything the label needs and
 * nothing else, built from the aircraft's file. `flown` and the medals below
 * are the hangar's (they are the BESTS, which it re-reads per variant).
 */
export interface VariantCard {
  readonly vehicle: AircraftId
  readonly id: string
  readonly name: string
  readonly blurb: string
  readonly bars: readonly VariantBar[]
}

/**
 * Every variant of one aircraft the hangar OFFERS, in FILE order, which is slot
 * order (§6.2). A variant marked `listed: false` (not ready to ship: the
 * jumping spider, DEV-403) gets no table.
 */
export const variantCards = (aircraft: Aircraft): readonly VariantCard[] =>
  listedVariants(aircraft).map((v: AircraftVariant) => ({
    vehicle: aircraft.vehicle,
    id: v.id,
    name: v.name,
    blurb: v.blurb,
    bars: variantBars(aircraft.vehicle, v.scale, aircraft),
  }))

/**
 * What the hangar needs to know about aircraft variants (DEV-382), so the room
 * never reads the content files, the edition or the store itself — and a test
 * can hand it the plan's three-variant fixture and a real edition.
 */
export interface VariantStep {
  /** Does the step exist? The LIVE edition's `gameplay.variants.enabled`. */
  enabled(): boolean
  /** One aircraft's variants, in its file's order. Empty: no step for it. */
  cardsFor(vehicle: string): readonly VariantCard[]
  /**
   * The variant this aircraft last flew, or null. Its table says so, and its
   * records are the ones the aircraft's tables carry until you pick one.
   */
  lastFlown(vehicle: string): string | null
}

/** An aircraft the variant files can describe: the whitelist's keys, never a list here. */
const isAircraftId = (vehicle: string): vehicle is AircraftId =>
  Object.hasOwn(VARIANT_SCALE_KEYS, vehicle)

/**
 * The hangar's variant step, from the live edition, the aircraft files and the
 * remembered choice. What `boot/app.ts` hands `createHangar`.
 *
 * `edition` is read on every question, so a preset flip takes the step away
 * (or brings it back) at the room's next re-lay. An aircraft with no variants
 * file, or a file that fails validation, has no step: the room goes straight to
 * its flight plans, which is 2016, rather than stranding the player on an empty
 * arc. `lastFlown` is handed the ids the file has now, so a remembered id a
 * later build removed reads as nothing rather than as a table that is not there.
 */
export const variantStep = (
  edition: () => VariantsEdition,
  aircraftOf: (vehicle: AircraftId) => Aircraft,
  lastFlown: (vehicle: AircraftId, known: readonly string[]) => string | null,
): VariantStep => {
  const cards = new Map<string, readonly VariantCard[]>()
  const cardsFor = (vehicle: string): readonly VariantCard[] => {
    const hit = cards.get(vehicle)
    if (hit) return hit
    let dealt: readonly VariantCard[] = []
    if (isAircraftId(vehicle)) {
      try {
        dealt = variantCards(aircraftOf(vehicle))
      } catch (error) {
        console.warn(`hangar: no variant step for the ${vehicle} —`, error)
      }
    }
    cards.set(vehicle, dealt)
    return dealt
  }
  return {
    enabled: () => edition().gameplay.variants.enabled,
    cardsFor,
    lastFlown: (vehicle) =>
      isAircraftId(vehicle)
        ? lastFlown(
            vehicle,
            cardsFor(vehicle).map((c) => c.id),
          )
        : null,
  }
}
