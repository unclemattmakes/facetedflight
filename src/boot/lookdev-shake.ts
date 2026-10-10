// src/boot/lookdev-shake.ts — the buffet's engine curve on `?lookdev=1`. DEV-528.
//
// DEV-426 weighed the cockpit buffet by what the engine is doing, with three
// numbers Matt picked; DEV-528 set all three to 1 (the buffet as DEV-083 built
// it) because he preferred the old jitter, and kept the curve so he can shape
// it later: *"maybe i should just adjust the curve and then fine-tune later"*.
// This is where he adjusts it: a slider for each weight, live on the ship you
// are flying, and a **Copy JSON** that hands back the block to paste under
// `cockpit.shake.throttle`.
//
// `lookdev.ts`'s contract holds: nothing here writes a file, nothing persists
// across a reload, and the preset stays the source of truth. The panel never
// writes the preset; it holds its own copy of the three numbers, and `shake()`
// hands the buffet that copy only once a slider has moved, so a build with the
// panel open and untouched flies exactly the preset.

import type { EditionCockpitShake, EditionShakeThrottle } from '@/content/edition-schema'
import type { LookdevGroup } from './lookdev'

type Weights = { -readonly [K in keyof EditionShakeThrottle]: EditionShakeThrottle[K] }

export interface ShakeLookdev {
  /**
   * The shake block for `flight.shake()`: `base` itself until a slider moves,
   * then `base` with the panel's weights. Cached per `base`, so a frame
   * allocates nothing.
   */
  shake(base: EditionCockpitShake): EditionCockpitShake
  /** The panel's group, or null where it would be inert (no curve, or the buffet off). */
  group(base: EditionCockpitShake, editionId: string): LookdevGroup | null
}

const WEIGHTS: readonly { key: keyof EditionShakeThrottle; label: string }[] = [
  { key: 'fullThrottle', label: 'full throttle, unboosted (and below it)' },
  { key: 'boost', label: 'boost, the instant it spools up' },
  { key: 'topSpeed', label: 'boosting at top speed (the chain’s terminal)' },
]

export const createShakeLookdev = (): ShakeLookdev => {
  let live: Weights | null = null
  let cachedBase: EditionCockpitShake | null = null
  let cached: EditionCockpitShake | null = null

  return {
    shake(base) {
      if (!live || !base.throttle) return base
      if (cachedBase !== base || !cached) {
        cachedBase = base
        // The copy holds `live` by reference, so a later drag needs no rebuild.
        cached = { ...base, throttle: live }
      }
      return cached
    },
    group(base, editionId) {
      const start = base.throttle
      if (!base.enabled || !start) return null
      // A new world, a new panel: the last session's numbers go, and the
      // preset flies until a slider moves (the scene tint's rule, DEV-446).
      live = null
      cachedBase = null
      cached = null
      const panel: Weights = {
        fullThrottle: start.fullThrottle,
        boost: start.boost,
        topSpeed: start.topSpeed,
      }
      const file = `content/editions/${editionId}.json`
      return {
        title: 'cockpit buffet — engine curve (DEV-426 / DEV-528)',
        controls: WEIGHTS.map(({ key, label }) => ({
          label: `${label} (× amplitude)`,
          min: 0,
          max: 2,
          step: 0.05,
          get: () => panel[key],
          set: (v: number) => {
            panel[key] = v
            live = panel
          },
          source: `${file}  cockpit.shake.throttle.${key} = %`,
          digits: 2,
        })),
        json: {
          path: `${file}  cockpit.shake.throttle`,
          value: () => ({ ...start, ...panel }),
        },
      }
    },
  }
}
