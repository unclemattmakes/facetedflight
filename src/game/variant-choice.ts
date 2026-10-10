// src/game/variant-choice.ts — which variant of each aircraft you flew last.
// DEV-382.
//
// docs/plan/AIRCRAFT-VARIANTS.md §6.3: *"The choice persists per aircraft in
// `ff2.variant.v1` (`{"hoverjet": "speed", "jumpseat": "standard"}`), through
// `safeStorage` and validated per field, the `boot/settings.ts` idiom: an
// unknown id or a throwing store reads as `standard`."*
//
// It is written when a course is BOARDED, not when a variant table is pressed:
// the hangar's label says "LAST FLOWN" of it, and a table you looked at and
// backed out of was not flown. It is what Quick Race flies (Matt's answer to
// open call 11: your last HoverJet variant) and what the hangar's labels mark.
//
// **Anniversary only, and Classic never writes it** (§8). Classic has no
// variant step; its flights are built from the sheet itself whatever this
// says, and the record is KEPT, not cleared, so switching back to Anniversary
// restores it. `boot/app.ts` holds that rule at its one write site.
//
// Not the sim's business (rule 4: `localStorage` is DOM), and not the edition's
// (a choice is the player's, not a look preset's).

import { type AircraftId, STANDARD_VARIANT_ID } from '@/content/aircraft-schema'
import { safeStorage } from '@/game/personal-best'
import { readJsonKey, writeJsonKey } from '@/game/storage'

/** The one storage key. The suffix is the escape hatch, as `bestKey`'s is. */
export const VARIANT_CHOICE_KEY = 'ff2.variant.v1'

type Store = Pick<Storage, 'getItem' | 'setItem'>

/**
 * Every field stored, keeping only those that are strings. A record that does
 * not parse, is not an object, or comes from a store that throws is empty:
 * nothing stored, which reads as `standard` everywhere.
 */
const readAll = (storage: Store | null): Record<string, string> => {
  const parsed = readJsonKey(storage, VARIANT_CHOICE_KEY)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * The variant `vehicle` last flew, when one was remembered and it is one of
 * `known`, the ids that aircraft's file has NOW — or null: nothing stored, an
 * id a later build removed (or a hand-edited key names), garbage, a store that
 * throws. Null is what the hangar's LAST FLOWN label needs: a first visit has
 * flown nothing, and marking `standard` there would be a claim about a flight
 * that never happened.
 *
 * `known` is passed rather than read so this stays free of the content glob,
 * and so a test can hand in the plan's three-variant fixture.
 */
export const rememberedVariant = (
  vehicle: AircraftId,
  known: readonly string[],
  storage: Store | null = safeStorage(),
): string | null => {
  const id = readAll(storage)[vehicle]
  return id !== undefined && known.includes(id) ? id : null
}

/** {@link rememberedVariant}, reading `standard` where nothing is remembered: what a flight is built from. */
export const storedVariant = (
  vehicle: AircraftId,
  known: readonly string[],
  storage: Store | null = safeStorage(),
): string => rememberedVariant(vehicle, known, storage) ?? STANDARD_VARIANT_ID

/** Where a flight's variant came from. See {@link flightVariantRequest}. */
export type FlightVariantSource = 'pin' | 'hangar' | 'last flown' | 'none'

/**
 * Which variant a flight is built from, by precedence, on an edition WITH the
 * variant step (Classic builds `standard`, always). DEV-382 follow-up.
 *
 *  1. **`?variant=`, when it names a variant this aircraft has.** A PIN for the
 *     page's life, as `?edition=` and `?quality=` are (DEV-380: *"never
 *     written back"*): it wins over the hangar and the store, so a direct
 *     `?mission=…&variant=speed` boot flies the speed jet whichever table is
 *     pressed. DEV-382 first put the hangar's board ahead of it, and every
 *     completion spec that boots a variant and then walks the menu flew
 *     `standard`. A pin that names a variant this aircraft lacks does not
 *     apply to it, so it falls through.
 *  2. The variant BOARDED at the hangar this page's life.
 *  3. The one this aircraft last flew (`ff2.variant.v1`), if the file still
 *     has it.
 *  4. Nothing: `standard`.
 *
 * Pure: `known` is the aircraft's variant ids, so a test hands in a fixture.
 */
export const flightVariantRequest = (
  pin: string | null,
  known: readonly string[],
  boarded: string | undefined,
  remembered: string | null,
): { readonly id: string | null; readonly source: FlightVariantSource } => {
  if (pin !== null && known.includes(pin)) return { id: pin, source: 'pin' }
  if (boarded !== undefined) return { id: boarded, source: 'hangar' }
  if (remembered !== null && known.includes(remembered)) {
    return { id: remembered, source: 'last flown' }
  }
  return { id: null, source: 'none' }
}

/**
 * Remember that `vehicle` was flown as `id`, keeping every other aircraft's
 * field (including ones this build does not know, so a newer build's choice
 * survives an older one). Never throws: a private window loses the memory, not
 * the flight.
 */
export const rememberVariant = (
  vehicle: AircraftId,
  id: string,
  storage: Store | null = safeStorage(),
): void => {
  // Quota, a blocked context: the run still happens in the variant chosen.
  writeJsonKey(storage, VARIANT_CHOICE_KEY, { ...readAll(storage), [vehicle]: id })
}
