// src/boot/app/horizon.ts — where the far shore stands, and the seed it is
// drawn from.
//
// Moved verbatim out of `boot/app.ts` (APP-SPLIT phase 1,
// `docs/plan/APP-SPLIT.md`), with `export` added and nothing else. Both are
// pure functions of their arguments.

import { fnv1a32 } from '@/sim/math/hash'
import type { HeightField } from '@/sim/terrain/height-field'

/**
 * The level the far shore's ridges stand on (DEV-119): the sea's surface where
 * the environment has one — read off the OCEAN's collision field, which is the
 * plate without the wave — and otherwise the land's 20th-percentile height, a
 * valley floor, so a ring round alpine or desert starts under the low ground
 * rather than under a sea that is not there.
 */
export const horizonReferenceY = (land: HeightField, sea: HeightField | null): number => {
  const field = sea ?? land
  const sorted = Float32Array.from(field.heights).sort()
  const at = sea ? 0.5 : 0.2
  const sample = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))] ?? 0
  return field.originY + sample * field.terrainHeight * (field.scaleY || 1)
}

/** A fixed seed per mission id, so two loads give the same shore. */
export const horizonSeed = (id: string): number => fnv1a32(id)
