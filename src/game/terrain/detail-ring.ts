// src/game/terrain/detail-ring.ts — whether THIS terrain gets a detail ring.
//
// The sim half is `sim/terrain/detail.ts`: a band, some params and a queue
// plan, all pure. This is the half that knows about presets, comfort settings
// and which of the two `FacetedTerrain`s in a mission is the water — and it is
// a separate file, and a pure function, because every one of those exclusions is
// a silent failure if it is wrong:
//
//  * the ring on the OCEAN would not be a detail ring, it would be the whole
//    sea. The water plate is 1,024-unit chunks at a scale of 8 — **8,192 m
//    across** — with its own density knob (`?ocean=`, DEV-023) and its own
//    32 m base resolution. A "ring" of 320 m around the ship touches the one
//    chunk it is standing on and regenerates 8 km of water at 4 m: 4 million
//    quads, in a worker, to change nothing the player can see. Nothing throws.
//  * the ring at quality `low` is the comfort preset spending frame time it
//    exists to save. `render/quality.ts` is the file that says when the budget
//    has run out and what gives — and R12's *"a dropped frame during a fast roll
//    is nauseogenic"* is the reason the answer is never the frame.
//  * the ring on Classic is not Classic.
//
// Read as a GETTER, once per `updateLod`, never cached: the preset and the
// comfort settings both flip mid-run from the pause menu (`app.ts`'s
// `onSettings`), and a cached spec is a ring that stays on after the player
// turned it off. That is `edition.ts`'s standing rule — *"a getter, cheap, and
// always the live one"* — applied to a terrain.

import type { QualitySetting } from '@/boot/settings'
import type { EditionDetailRing } from '@/content/edition-schema'
import type { DetailRingSpec } from '@/sim/terrain/detail'

export interface DetailRingContext {
  /**
   * True for the water plate. See the header — this is the exclusion with no
   * symptom, because a sea regenerated at 4 m looks exactly like a sea.
   */
  readonly isOcean: boolean
  /** The live comfort quality. `low` turns the ring off. */
  readonly quality: QualitySetting
}

/**
 * The spec this terrain should run with, or null for no ring at all.
 *
 * Null is the answer for Classic, for the ocean, for quality `low`, for a
 * radius of zero and for a preset that has been hand-edited into nonsense. The
 * caller does not branch: `loadTerrain` takes the provider, `detailBand` turns
 * null into "LOD −1 is unreachable", and `selectLod` then behaves exactly as it
 * did before this file existed.
 */
export const detailRingFor = (
  ring: EditionDetailRing | undefined | null,
  ctx: DetailRingContext,
): DetailRingSpec | null => {
  if (!ring?.enabled) return null
  if (ctx.isOcean) return null
  if (ctx.quality === 'low') return null
  if (!(ring.radius > 0) || !(ring.baseResolution > 0) || !(ring.maxInFlight >= 1)) return null
  return {
    baseResolution: ring.baseResolution,
    radius: ring.radius,
    jitterScale: ring.jitterScale,
    maxInFlight: Math.floor(ring.maxInFlight),
    smoothMetres: ring.smoothMetres,
  }
}
