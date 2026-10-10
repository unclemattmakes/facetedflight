// src/content/aircraft-schema.ts — what an aircraft variant is allowed to say.
// DEV-380.
//
// docs/plan/AIRCRAFT-VARIANTS.md §2. A variant is a second pick after the
// aircraft (Matt, 2026-09-24: *"a new selection after the aircraft type"*),
// and it is DATA: `content/aircraft/<vehicle>.json` holds, per variant, only
// dimensionless MULTIPLIERS on named keys of the generated sheet. The sheet
// stays 2016's; `sim/variant.ts`'s `scaleSheet` applies the factors at the
// vehicle's construction seam; `standard` is the sheet because its block is
// empty. So no number that looks like physics is ever typed (hard rule 3), and
// a new variant is a JSON edit (hard rule 6).
//
// This module is the runtime check on the shape the code reads — the
// `validateEdition` pattern. `content/aircraft/_schema.json` is the gate on the
// FILES and `tests/unit/aircraft-content.test.ts` runs it. Everything here
// fails at load with the file's name in the message, rather than at frame 400.
//
// **The whole feature is Anniversary only** (§8). The edition's
// `gameplay.variants.enabled` decides whether the step exists; with it off,
// `resolveVariantIn` returns `standard` whatever was asked for, so a Classic
// flight is built from the sheet itself — a no-op twice over.

import { HOVERJET, JUMPSEAT } from '@/generated/constants.generated'
import { isRecord } from '@/net/validate-kit'
import type { CurveKey } from '@/sim/art-lean'
import type { GliderTuning } from '@/sim/glider'
import type { JumpSpec } from '@/sim/jumpseat-jump'
import { type SheetScale, sheetValue } from '@/sim/variant'
import type { VehicleId } from './level-schema'

/** The aircraft a variant file can describe. Every `VehicleId`, and nothing else. */
export type AircraftId = VehicleId

/**
 * The variant every aircraft MUST carry, with an empty scale: 2016's own
 * machine. The id is also the storage key's default (a stored choice that no
 * longer exists reads as this) and the one `?variant=` falls back to.
 */
export const STANDARD_VARIANT_ID = 'standard'

/**
 * The sheet keys a variant may SCALE, per aircraft — §1.4's tables minus
 * `rigidbody.mass`.
 *
 * Mass is out on purpose: the racer grid's hover height (DEV-156) and DEV-364's
 * craft contact share an overlap by inverse mass, so a heavier hull that wins
 * every shove is a variant nobody asked for. Every `world.*` key is out of
 * every list: dt and gravity are not a vehicle's (a JumpSeat that falls faster
 * is DEV-384's per-seat `gravityScale` MECHANIC, not an edit of the world).
 * The hull's colliders, the legs' geometry and the HoverJet's hover cushion are
 * out because a variant is the same airframe (§6.2).
 *
 * **Every key here must MOVE its vehicle.** A key nothing reads is a menu that
 * lies (DEV-069), and `tests/unit/variant-data.test.ts` scales each one by 2
 * on its own, flies the frozen script, and asserts the flight changed. Adding a
 * key the vehicle does not read turns that test red — which is the point.
 */
export const VARIANT_SCALE_KEYS: Readonly<Record<AircraftId, readonly string[]>> = {
  hoverjet: [
    'ship.maxSpeed',
    'ship.boostMultiplier',
    'ship.acceleration',
    'ship.driftMultiplier',
    'ship.liftMultiplier',
    'ship.rollRate',
    'ship.pitchRate',
    'ship.yawRate',
    'ship.airbrakeSpeed',
    'rigidbody.drag',
    'rigidbody.angularDrag',
    'energy.engineBurnrate',
    'energy.BoostBurnrate',
  ],
  jumpseat: [
    'thruster.thrustForce',
    'thruster.boostMultiplier',
    'thruster.accelTime',
    'rigidbody.drag',
    'rigidbody.angularDrag',
    'dragHack.drag_freefall',
    'hoverMotor.hoverForce',
    'hoverMotor.hoverHeight',
    'fuel.maxFuel',
    'fuel.burnRate',
    'fuel.boostBurnRateMultiplier',
    'orientation.rollRate',
    'orientation.pitchRate',
    'orientation.yawRate',
  ],
  // DEV-399. NONE, and not for want of trying: the glider's fields are SOLVED
  // from three chosen numbers (DEV-145), so scaling one moves the others'
  // meaning — ×0.8 on `parasiteDrag` raised the glide ratio from 7 to 8.1 for
  // free (AIRCRAFT-VARIANTS §3.3). Its variants arrive at G5 as DESIGN targets
  // that re-solve the tuning, not as scales on it.
  glider: [],
}

/**
 * The keys an aircraft's OWN file must carry as absolute numbers, because no
 * generated sheet has them — or null where the sheet is the source (DEV-399).
 *
 * 2016 shipped two aircraft and the extractor reads both off their prefabs;
 * the glider was authored and switched off everywhere (DEV-145), so under hard
 * rule 2 it has nothing to extract and its numbers are Anniversary design. They
 * lived on the one course (`Level.flightModel`) until G1, whose plan row asks
 * for exactly this move: `level-schema.ts`'s own note said the block "should
 * move to a shared vehicle JSON before it is copied".
 *
 * Every key `sim/glider.ts`'s `GliderTuning` requires, and no other —
 * `tests/unit/glider-wire.test.ts` holds the list to `PROTOTYPE_GLIDER`'s keys.
 */
export const GLIDER_TUNING_KEYS: readonly (keyof GliderTuning)[] = [
  'mass',
  'angularDrag',
  'aeroScale',
  'liftSlope',
  'liftMax',
  'parasiteDrag',
  'inducedDrag',
  'stallSpeed',
  'stallWidth',
  'stalledControl',
  'trimAngleOfAttack',
  'weathervane',
  'weathervaneYaw',
  'pitchDamping',
  'rollRate',
  'pitchRate',
  'yawRate',
  'sideBleed',
  'rocketThrust',
  'rocketSeconds',
  'rocketRecharge',
  'groundEffectHeight',
  'groundEffectGain',
]

export const AIRCRAFT_TUNING_KEYS: Readonly<Record<AircraftId, readonly string[] | null>> = {
  hoverjet: null,
  jumpseat: null,
  glider: GLIDER_TUNING_KEYS,
}

/**
 * Keys that are a FRACTION of a velocity deleted every tick. Scaled to 1 or
 * above, the bleed deletes the whole component every tick (or reverses it),
 * which is not a tuning, it is a different integrator. Refused.
 */
export const PER_TICK_BLEED_KEYS: readonly string[] = [
  'ship.driftMultiplier',
  'ship.liftMultiplier',
]

/**
 * The `mechanics` a variant may carry, per aircraft: absolute numbers for a
 * mechanic 2016 never had, so there is nothing on the sheet to scale (§2.2).
 * Only what a sim implements — DEV-383 adds the JumpSeat's `jump` — so a file
 * naming a mechanic no code runs is refused rather than silently ignored.
 *
 * `gravityScale` (DEV-384) is `sim/jumpseat.ts`'s `JumpSeatMechanics`: a
 * multiplier on the WORLD's gravity for that seat alone. Never `world.gravity`,
 * which no whitelist names: the world stays (0, −32, 0).
 *
 * `jump` (DEV-383) is the jumping spider's charge-and-launch,
 * `sim/jumpseat-jump.ts`'s `JumpSpec`; `validateJump` below is its check.
 */
export const VARIANT_MECHANICS: Readonly<Record<AircraftId, readonly string[]>> = {
  hoverjet: [],
  jumpseat: ['gravityScale', 'jump'],
  glider: [],
}

/**
 * `mechanics.jump`'s numeric fields, each with what it must be. Exported so the
 * test and `_schema.json` can be held to one list.
 */
export const JUMP_NUMBER_FIELDS = [
  'chargeSeconds',
  'minChargeSeconds',
  'impulseMin',
  'impulseMax',
  'burstSeconds',
  'graceSeconds',
] as const

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/**
 * The check on a jump (DEV-383). Refuses, naming the field: a missing or extra
 * key; a charge or burst that is not a finite time above zero; a minimum charge
 * below zero or longer than the whole charge (a jump that can never fire); an
 * impulse below zero, or a full charge weaker than a tap; and a `curve` that is
 * not ascending keys on [0, 1] with finite values in [0, 1] — so the dv a
 * charge buys always lies between the two impulses at the keys.
 */
export const validateJump = (jump: unknown, at: string): JumpSpec => {
  if (!isRecord(jump)) throw new AircraftSchemaError(at, 'mechanics.jump must be an object')
  const allowed: readonly string[] = [...JUMP_NUMBER_FIELDS, 'curve']
  for (const key of Object.keys(jump)) {
    if (!allowed.includes(key)) {
      throw new AircraftSchemaError(at, `mechanics.jump has no field "${key}"`)
    }
  }
  for (const key of JUMP_NUMBER_FIELDS) {
    if (!finite(jump[key])) {
      throw new AircraftSchemaError(at, `mechanics.jump.${key} must be a finite number`)
    }
  }
  const spec = jump as unknown as JumpSpec
  if (!(spec.chargeSeconds > 0))
    throw new AircraftSchemaError(at, 'mechanics.jump.chargeSeconds must be above zero')
  if (!(spec.burstSeconds > 0))
    throw new AircraftSchemaError(at, 'mechanics.jump.burstSeconds must be above zero')
  if (!(spec.minChargeSeconds >= 0 && spec.minChargeSeconds <= spec.chargeSeconds)) {
    throw new AircraftSchemaError(
      at,
      'mechanics.jump.minChargeSeconds must lie between zero and chargeSeconds',
    )
  }
  if (!(spec.graceSeconds >= 0))
    throw new AircraftSchemaError(at, 'mechanics.jump.graceSeconds must not be negative')
  if (!(spec.impulseMin >= 0))
    throw new AircraftSchemaError(at, 'mechanics.jump.impulseMin must not be negative')
  if (!(spec.impulseMax >= spec.impulseMin && spec.impulseMax > 0)) {
    throw new AircraftSchemaError(
      at,
      'mechanics.jump.impulseMax must be above zero and at least impulseMin',
    )
  }
  const curve: unknown = jump.curve
  const keys: unknown = isRecord(curve) ? curve.keys : undefined
  if (!isRecord(curve) || Object.keys(curve).some((k) => k !== 'keys') || !Array.isArray(keys)) {
    throw new AircraftSchemaError(at, 'mechanics.jump.curve must be { keys: [...] }')
  }
  if (keys.length === 0) throw new AircraftSchemaError(at, 'mechanics.jump.curve has no keys')
  let last = Number.NEGATIVE_INFINITY
  for (const [i, k] of (keys as unknown[]).entries()) {
    const fields: readonly (keyof CurveKey)[] = ['time', 'value', 'inSlope', 'outSlope']
    if (
      !isRecord(k) ||
      Object.keys(k).some((f) => !(fields as readonly string[]).includes(f)) ||
      !fields.every((f) => finite(k[f]))
    ) {
      throw new AircraftSchemaError(
        at,
        `mechanics.jump.curve.keys[${i}] must be { time, value, inSlope, outSlope }, all finite`,
      )
    }
    const key = k as unknown as CurveKey
    if (!(key.time >= 0 && key.time <= 1 && key.time > last)) {
      throw new AircraftSchemaError(
        at,
        `mechanics.jump.curve.keys[${i}].time must rise strictly and lie in [0, 1]`,
      )
    }
    if (!(key.value >= 0 && key.value <= 1)) {
      throw new AircraftSchemaError(at, `mechanics.jump.curve.keys[${i}].value must lie in [0, 1]`)
    }
    last = key.time
  }
  return spec
}

/**
 * Mechanics that are dimensionless FACTORS, refused exactly as a `scale` factor
 * is: a finite number above zero. `gravityScale` 0 is a seat that never falls,
 * and a negative one falls up.
 */
export const MECHANIC_FACTORS: readonly string[] = ['gravityScale']

/**
 * The real sheet each aircraft's keys are checked against. The glider has none
 * (DEV-399): its numbers are its own file's `tuning`, and it scales nothing.
 */
const SHEETS: Readonly<Partial<Record<AircraftId, object>>> = {
  hoverjet: HOVERJET,
  jumpseat: JUMPSEAT,
}

/** An id is a storage-key and URL segment: lower-case, no dots. */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

export interface AircraftVariant {
  /** Slot order is file order; the id is what storage, bests and `?variant=` key on. */
  readonly id: string
  /** What the hangar table says. */
  readonly name: string
  /** One line under the name. Matt's words, where he gave them. */
  readonly blurb: string
  /**
   * `false`: NOT READY TO SHIP. The hangar does not offer it and a remembered
   * choice of it flies `standard` (`listedVariants`); `?variant=<id>` still
   * flies it, a development switch, as `?mission=` is for an unlisted course.
   * Absent is listed, and `standard` always is.
   */
  readonly listed?: boolean
  /** Sheet key -> multiplier. Empty on `standard`, by rule. */
  readonly scale: SheetScale
  /**
   * Numbers for a mechanic 2016 never had: DEV-384's `gravityScale` and
   * DEV-383's `jump`, the JumpSeat's two (`VARIANT_MECHANICS`).
   */
  readonly mechanics?: Readonly<Record<string, unknown>>
  readonly note?: string
}

export interface Aircraft {
  readonly vehicle: AircraftId
  readonly note?: string
  /**
   * DEV-399. The aircraft's own absolute numbers, where no generated sheet has
   * them: the glider's, every key in {@link GLIDER_TUNING_KEYS}. Refused on an
   * aircraft whose numbers are 2016's sheet, where it would be a second source.
   */
  readonly tuning?: Readonly<Record<string, number>>
  readonly variants: readonly AircraftVariant[]
}

export class AircraftSchemaError extends Error {
  constructor(where: string, detail: string) {
    super(`Aircraft "${where}": ${detail}`)
    this.name = 'AircraftSchemaError'
  }
}

const isAircraftId = (x: unknown): x is AircraftId =>
  typeof x === 'string' && Object.hasOwn(VARIANT_SCALE_KEYS, x)

const nonEmptyString = (x: unknown): x is string => typeof x === 'string' && x.length > 0

/**
 * The runtime check. Refuses, with the file and the variant in the message:
 *
 *  - a `scale` key outside the aircraft's whitelist (`rigidbody.mass`,
 *    `world.gravity`, a typo), or one that does not name a finite number on
 *    the REAL generated sheet — the whitelist is itself checked against the
 *    sheet, so a whitelist typo cannot hide either;
 *  - a factor that is not a finite number above zero, and a factor that would
 *    push a per-tick bleed to 1 or above;
 *  - no `standard`, a `standard` that scales anything or carries a mechanic,
 *    and two variants with one id;
 *  - a `mechanics` key the aircraft's sim does not implement.
 */
export const validateAircraft = (aircraft: Aircraft, where: string = 'aircraft'): Aircraft => {
  if (!isRecord(aircraft)) throw new AircraftSchemaError(where, 'is not an object')
  const vehicle: unknown = aircraft.vehicle
  if (!isAircraftId(vehicle)) {
    throw new AircraftSchemaError(
      where,
      `vehicle ${JSON.stringify(vehicle)} is not one of ${Object.keys(VARIANT_SCALE_KEYS).join(', ')}`,
    )
  }
  const variants: unknown = aircraft.variants
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new AircraftSchemaError(where, 'variants must be a non-empty array')
  }
  // DEV-399. An aircraft with no generated sheet carries its own numbers, every
  // one of them, and an aircraft WITH a sheet carries none: a hand-authored
  // file is the one thing the extractor's discipline does not cover, and a
  // missing key would reach the sim as `undefined` and leave as NaN positions.
  const tuningKeys = AIRCRAFT_TUNING_KEYS[vehicle]
  const tuning: unknown = aircraft.tuning
  if (tuningKeys === null) {
    if (tuning !== undefined) {
      throw new AircraftSchemaError(
        where,
        `the ${vehicle}'s numbers are 2016's generated sheet; a tuning block here would be a second source`,
      )
    }
  } else {
    if (!isRecord(tuning)) {
      throw new AircraftSchemaError(where, `the ${vehicle} needs a tuning block: it has no sheet`)
    }
    const missing = tuningKeys.filter((k) => !Number.isFinite(tuning[k]))
    if (missing.length > 0) {
      throw new AircraftSchemaError(
        where,
        `tuning is missing or non-numeric: ${missing.join(', ')}`,
      )
    }
    const extra = Object.keys(tuning).filter((k) => !tuningKeys.includes(k))
    if (extra.length > 0) {
      throw new AircraftSchemaError(
        where,
        `tuning has key(s) the ${vehicle} does not read: ${extra.join(', ')}`,
      )
    }
  }
  const sheet: object = SHEETS[vehicle] ?? (tuning as object)
  const allowed = VARIANT_SCALE_KEYS[vehicle]
  const mechanicsAllowed = VARIANT_MECHANICS[vehicle]
  const seen = new Set<string>()
  for (const [i, v] of (variants as unknown[]).entries()) {
    if (!isRecord(v)) throw new AircraftSchemaError(where, `variants[${i}] is not an object`)
    const id = v.id
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new AircraftSchemaError(
        where,
        `variants[${i}].id ${JSON.stringify(id)} must be lower-case letters, digits and dashes`,
      )
    }
    const at = `${where}.${id}`
    if (seen.has(id)) throw new AircraftSchemaError(where, `two variants have the id "${id}"`)
    seen.add(id)
    if (!nonEmptyString(v.name)) throw new AircraftSchemaError(at, 'needs a name')
    if (!nonEmptyString(v.blurb)) throw new AircraftSchemaError(at, 'needs a blurb')
    if (v.listed !== undefined && typeof v.listed !== 'boolean') {
      throw new AircraftSchemaError(at, `listed must be true or false, not ${String(v.listed)}`)
    }

    const scale = v.scale
    if (!isRecord(scale)) throw new AircraftSchemaError(at, 'scale must be an object')
    for (const [key, factor] of Object.entries(scale)) {
      if (!allowed.includes(key)) {
        throw new AircraftSchemaError(
          at,
          `scale key "${key}" is not one a ${vehicle} variant may scale. Allowed: ${allowed.join(', ')}`,
        )
      }
      const base = sheetValue(sheet, key)
      if (typeof base !== 'number' || !Number.isFinite(base)) {
        throw new AircraftSchemaError(
          at,
          `scale key "${key}" is not a number on the ${vehicle} sheet`,
        )
      }
      if (typeof factor !== 'number' || !Number.isFinite(factor) || !(factor > 0)) {
        throw new AircraftSchemaError(
          at,
          `scale["${key}"] must be a finite number above zero, not ${String(factor)}`,
        )
      }
      if (PER_TICK_BLEED_KEYS.includes(key) && !(base * factor < 1)) {
        throw new AircraftSchemaError(
          at,
          `scale["${key}"] takes a per-tick bleed to ${base * factor}; at 1 or above it deletes the whole velocity every tick`,
        )
      }
    }

    const mechanics = v.mechanics
    if (mechanics !== undefined) {
      if (!isRecord(mechanics)) throw new AircraftSchemaError(at, 'mechanics must be an object')
      for (const [key, value] of Object.entries(mechanics)) {
        if (!mechanicsAllowed.includes(key)) {
          throw new AircraftSchemaError(
            at,
            `mechanics "${key}" is not implemented for the ${vehicle}${
              mechanicsAllowed.length
                ? `. Known: ${mechanicsAllowed.join(', ')}`
                : ' (it has none yet)'
            }`,
          )
        }
        if (
          MECHANIC_FACTORS.includes(key) &&
          (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0))
        ) {
          throw new AircraftSchemaError(
            at,
            `mechanics["${key}"] must be a finite number above zero, not ${String(value)}`,
          )
        }
        if (key === 'jump') validateJump(value, at)
      }
    }

    if (id === STANDARD_VARIANT_ID) {
      if (v.listed === false) {
        throw new AircraftSchemaError(
          at,
          'standard is what every other choice falls back to; it cannot be unlisted',
        )
      }
      if (Object.keys(scale).length > 0) {
        throw new AircraftSchemaError(at, 'standard is 2016 by construction and must scale nothing')
      }
      if (mechanics !== undefined && Object.keys(mechanics).length > 0) {
        throw new AircraftSchemaError(
          at,
          'standard is 2016 by construction and carries no mechanics',
        )
      }
    }
  }
  if (!seen.has(STANDARD_VARIANT_ID)) {
    throw new AircraftSchemaError(where, `has no "${STANDARD_VARIANT_ID}" variant`)
  }
  return aircraft
}

/**
 * The variants a player is OFFERED, in file order: every one not marked
 * `listed: false`. The hangar deals its tables from these, and a remembered
 * choice is honoured only among them. `resolveVariantIn` does not ask: a
 * request by id (`?variant=`) still flies an unlisted variant.
 */
export const listedVariants = (aircraft: Aircraft): readonly AircraftVariant[] =>
  aircraft.variants.filter((v) => v.listed !== false)

/** The one edition flag this reads (`gameplay.variants`, §8). */
export interface VariantsEdition {
  readonly gameplay: { readonly variants: { readonly enabled: boolean } }
}

/** What a flight is built from: the chosen variant, or `standard` and why. */
export interface ResolvedVariant {
  readonly vehicle: AircraftId
  readonly id: string
  readonly name: string
  readonly scale: SheetScale
  readonly mechanics: Readonly<Record<string, unknown>>
  /**
   * Why the request was not honoured, for the console — or null when it was
   * (or when nothing was asked for). Never thrown: a typo in a URL or a stored
   * choice from a later build must not be a black page.
   */
  readonly note: string | null
}

/**
 * What a FLIGHT needs of a resolved variant: its id, its multipliers, and its
 * mechanics (DEV-384's `gravityScale` is the first a sim reads).
 * `game/flight.ts`'s `loadFlight` takes one.
 */
export type FlightVariant = Pick<ResolvedVariant, 'id' | 'scale' | 'mechanics'>

/**
 * 2016's machine — the `standard` id, no multipliers and no mechanics. The
 * default wherever a variant is optional, so every caller that predates
 * variants flies the sheet itself.
 */
export const STANDARD_FLIGHT_VARIANT: FlightVariant = Object.freeze({
  id: STANDARD_VARIANT_ID,
  scale: Object.freeze({}),
  mechanics: Object.freeze({}),
})

const resolved = (
  vehicle: AircraftId,
  v: AircraftVariant,
  note: string | null,
): ResolvedVariant => ({
  vehicle,
  id: v.id,
  name: v.name,
  scale: v.scale,
  mechanics: v.mechanics ?? {},
  note,
})

/**
 * The variant a flight is built from, given what was asked for.
 *
 *  - **Classic** (`gameplay.variants.enabled` false) returns `standard`
 *    whatever was asked, with a note when something else was: 2016 had one of
 *    each aircraft, and the step does not exist there.
 *  - Nothing asked for returns `standard`.
 *  - An id this aircraft does not have returns `standard`, with a note naming
 *    the ones it does.
 *
 * Pure: the aircraft is passed in, so a test can hand it a fixture. The game
 * goes through `content/load-aircraft.ts`'s `resolveVariant`.
 */
export const resolveVariantIn = (
  aircraft: Aircraft,
  requested: string | null | undefined,
  edition: VariantsEdition,
): ResolvedVariant => {
  const vehicle = aircraft.vehicle
  const standard = aircraft.variants.find((v) => v.id === STANDARD_VARIANT_ID)
  if (!standard) throw new AircraftSchemaError(vehicle, `has no "${STANDARD_VARIANT_ID}" variant`)
  const asked = requested ?? null
  if (!edition.gameplay.variants.enabled) {
    return resolved(
      vehicle,
      standard,
      asked !== null && asked !== STANDARD_VARIANT_ID
        ? `variant "${asked}" ignored: this edition has no aircraft variants, so the ${vehicle} flies ${STANDARD_VARIANT_ID}`
        : null,
    )
  }
  if (asked === null) return resolved(vehicle, standard, null)
  const found = aircraft.variants.find((v) => v.id === asked)
  if (found) return resolved(vehicle, found, null)
  return resolved(
    vehicle,
    standard,
    `the ${vehicle} has no variant "${asked}"; flying ${STANDARD_VARIANT_ID}. Known: ${aircraft.variants
      .map((v) => v.id)
      .join(', ')}`,
  )
}

// ── DEV-399: the glider, a third aircraft, and the edition it flies in ─────

/**
 * The glider's numbers, off its validated file. G1 has one variant, `standard`,
 * and every variant flies the file's tuning; G5's variants are DESIGN targets
 * (terminal dive, cruise, glide ratio) re-solved into a tuning
 * (AIRCRAFT-VARIANTS §3.3), which is where this grows a variant argument.
 * Throws on a file that is not the glider's, naming it.
 */
export const gliderTuningOf = (aircraft: Aircraft): GliderTuning => {
  if (aircraft.vehicle !== 'glider' || !aircraft.tuning) {
    throw new AircraftSchemaError(aircraft.vehicle, 'is not the glider, or carries no tuning')
  }
  return aircraft.tuning as unknown as GliderTuning
}

/** The edition flag an aircraft can stand behind: `gameplay.glider` (DEV-399). */
export interface AircraftEdition {
  readonly gameplay: { readonly glider: { readonly enabled: boolean } }
}

/**
 * Which aircraft a menu offers — the level list, the index and the hangar's
 * first step all ask it. A function of the live edition, read on every call,
 * so a preset flip adds or removes a table at the room's next re-lay.
 */
export type Fleet = (vehicle: string) => boolean

/**
 * The flag each aircraft stands behind, or null for none. 2016's two stand
 * behind nothing: every edition flies them. The glider, which 2016 authored at
 * every level of the game and switched off at every level (DEV-145), stands
 * behind `gameplay.glider` — on for Anniversary, off for Classic, so Classic
 * never sees it (AIRCRAFT-VARIANTS §5, G1).
 */
const AIRCRAFT_FLAGS: Readonly<Record<AircraftId, ((edition: AircraftEdition) => boolean) | null>> =
  {
    hoverjet: null,
    jumpseat: null,
    glider: (edition) => edition.gameplay.glider.enabled,
  }

/**
 * Does `edition` fly `vehicle`? A vehicle that is not an aircraft here answers
 * YES: the menus' standing rule is that an unknown vehicle still gets a table
 * (`game/mission-index.ts`), and a filter is not the place to drop one.
 */
export const editionFlies = (edition: AircraftEdition, vehicle: string): boolean => {
  const flag = isAircraftId(vehicle) ? AIRCRAFT_FLAGS[vehicle] : null
  return flag ? flag(edition) : true
}

/** The fleet of `edition`, read live through the function it is handed. */
export const fleetOf =
  (edition: () => AircraftEdition): Fleet =>
  (vehicle) =>
    editionFlies(edition(), vehicle)

/**
 * 2016's fleet: the two aircraft it shipped. What a caller with no edition in
 * hand gets — `levelIds()`, `loadMissionIndex()`, Quick Race's pool — so a
 * menu that forgets to ask shows Classic's hangar rather than Anniversary's.
 */
export const FLEET_2016: Fleet = (vehicle) =>
  editionFlies({ gameplay: { glider: { enabled: false } } }, vehicle)
