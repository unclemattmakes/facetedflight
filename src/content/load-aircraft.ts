// src/content/load-aircraft.ts — the only way an aircraft variant enters the
// game. DEV-380.
//
// The `load-edition.ts` shape: the files live in `content/aircraft/*.json`, are
// small, textual and versioned in git, and `import.meta.glob` makes the set a
// build-time list, so a third aircraft (the glider, AIRCRAFT-VARIANTS §5) is
// one file and no code. EAGER rather than lazy, unlike the editions: these are
// a few hundred bytes each and a flight is built synchronously from them at
// board time, so there is nothing to gain from a second round trip.
//
// Validated on first use, per aircraft, and cached — so one bad file stops the
// aircraft it describes with its own name in the message, not the whole boot.
//
// NOT imported by anything under `src/sim/`, and it must not be: the sim is
// handed a sheet-shaped object and never learns variants exist (§2.3).

import type { GliderTuning } from '@/sim/glider'
import {
  type Aircraft,
  type AircraftId,
  AircraftSchemaError,
  gliderTuningOf,
  type ResolvedVariant,
  resolveVariantIn,
  type VariantsEdition,
  validateAircraft,
} from './aircraft-schema'
import { globIds } from './glob-tree'

const modules = import.meta.glob<Aircraft>('/content/aircraft/*.json', {
  eager: true,
  import: 'default',
})

const PREFIX = '/content/aircraft/'

/** Every aircraft with a variants file. Sorted; `_schema.json` is not one. */
export const aircraftFileIds = (): string[] => globIds(modules, PREFIX)

const cache = new Map<AircraftId, Aircraft>()

/** The validated variants file for one aircraft. Throws, naming the file, if it is bad. */
export const aircraftFor = (vehicle: AircraftId): Aircraft => {
  const hit = cache.get(vehicle)
  if (hit) return hit
  const file = `content/aircraft/${vehicle}.json`
  const raw = modules[`${PREFIX}${vehicle}.json`]
  if (!raw) {
    throw new AircraftSchemaError(file, `missing. Known: ${aircraftFileIds().join(', ')}`)
  }
  const aircraft = validateAircraft(raw, file)
  if (aircraft.vehicle !== vehicle) {
    throw new AircraftSchemaError(file, `says it is the ${aircraft.vehicle}`)
  }
  cache.set(vehicle, aircraft)
  return aircraft
}

/**
 * The variant a flight of `vehicle` is built from. `requested` is `?variant=`
 * today and the hangar's stored choice after DEV-382. Classic, nothing asked
 * for, and an id this aircraft does not have all resolve `standard`; the
 * result's `note` says why, for the console. Never throws on the REQUEST — only
 * on a bad file, which is ours to fix.
 */
export const resolveVariant = (
  vehicle: AircraftId,
  requested: string | null | undefined,
  edition: VariantsEdition,
): ResolvedVariant => resolveVariantIn(aircraftFor(vehicle), requested, edition)

/**
 * The glider's numbers, off `content/aircraft/glider.json` (DEV-399). The one
 * door the flight takes to them: `sim/glider.ts` is handed a `GliderTuning`
 * and never learns where it came from.
 */
export const gliderTuning = (): GliderTuning => gliderTuningOf(aircraftFor('glider'))
